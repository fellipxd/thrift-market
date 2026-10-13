import { actOnReportInput, REPORT_REASON_LABEL, reverseModerationInput, submitReportInput, type ModerationActionKind, type ReportKind, type ReportReason } from '@thrift/contracts';
import { DomainError } from '@thrift/domain';
import { isUniqueViolation, many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireStaff, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enqueue } from '../core/outbox';
import { enforceRateLimit } from '../core/rate-limit';
import { parseInput } from '../core/validation';
import { withdrawStock } from '../inventory/authority';
import { stopOpenAuctions } from '../auctions/commands';
import { notifyUser } from '../notifications/notify';
import { applyReviewModeration } from './reviews';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReportTarget {
  kind: ReportKind;
  id: string;
  label: string;
  /** Who the action would affect (never shown to the reporter beyond the label). */
  ownerUserId: string | null;
  shopId: string | null;
}

/**
 * Resolves what is being reported, checking the reporter may see it: public listings/shops/users/reviews, and only
 * messages from conversations the reporter takes part in.
 */
async function resolveTarget(db: Queryable, kind: ReportKind, id: string, viewerId: string | null): Promise<ReportTarget | null> {
  if (!UUID.test(id)) return null;
  switch (kind) {
    case 'listing': {
      const r = await maybeOne<{ title: string; shop_id: string; owner_user_id: string }>(
        db,
        `SELECT l.title, l.shop_id, s.owner_user_id FROM listings l JOIN shops s ON s.id = l.shop_id WHERE l.id = $1 AND l.status NOT IN ('draft')`,
        [id],
      );
      return r ? { kind, id, label: `Listing: ${r.title}`, ownerUserId: r.owner_user_id, shopId: r.shop_id } : null;
    }
    case 'shop': {
      const r = await maybeOne<{ name: string; owner_user_id: string }>(db, `SELECT name, owner_user_id FROM shops WHERE id = $1 AND status <> 'draft'`, [id]);
      return r ? { kind, id, label: `Shop: ${r.name}`, ownerUserId: r.owner_user_id, shopId: id } : null;
    }
    case 'user': {
      const r = await maybeOne<{ display_name: string }>(db, `SELECT display_name FROM users WHERE id = $1 AND status <> 'deleted'`, [id]);
      return r ? { kind, id, label: `Member: ${r.display_name.split(' ')[0]}`, ownerUserId: id, shopId: null } : null;
    }
    case 'message': {
      const r = await maybeOne<{ body: string; sender_user_id: string | null; shop_id: string; can_see: boolean }>(
        db,
        `SELECT m.body, m.sender_user_id, c.shop_id,
                (c.buyer_user_id = $2 OR EXISTS (SELECT 1 FROM shop_members sm WHERE sm.shop_id = c.shop_id AND sm.user_id = $2)) AS can_see
           FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1`,
        [id, viewerId],
      );
      if (!r || (viewerId && !r.can_see)) return null;
      return { kind, id, label: `Message: “${r.body.slice(0, 80)}${r.body.length > 80 ? '…' : ''}”`, ownerUserId: r.sender_user_id, shopId: r.shop_id };
    }
    case 'review': {
      const r = await maybeOne<{ body: string; author_user_id: string; shop_id: string }>(db, `SELECT body, author_user_id, shop_id FROM reviews WHERE id = $1 AND status <> 'removed'`, [id]);
      return r ? { kind, id, label: `Review: “${r.body.slice(0, 80)}${r.body.length > 80 ? '…' : ''}”`, ownerUserId: r.author_user_id, shopId: r.shop_id } : null;
    }
  }
}

/** For the report page: what is being reported (or NOT_FOUND). */
export async function reportTarget(ctx: AppContext, kind: string, id: string): Promise<{ kind: ReportKind; id: string; label: string }> {
  const user = requireUser(ctx);
  if (!['listing', 'shop', 'user', 'message', 'review'].includes(kind)) throw new DomainError('NOT_FOUND', 'Nothing to report here.');
  const t = await resolveTarget(ctx.pool, kind as ReportKind, id, user.userId);
  if (!t) throw new DomainError('NOT_FOUND', 'Nothing to report here.');
  return { kind: t.kind, id: t.id, label: t.label };
}

/** Anyone signed in can report; one open report per reporter and target; rate limited. */
export async function submitReport(ctx: AppContext, raw: unknown): Promise<{ reportId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(submitReportInput, raw);
  await enforceRateLimit(ctx.pool, `report:${user.userId}`, 20, 86_400, 'You’ve sent a lot of reports today. Our team will review them — try again tomorrow.');
  const target = await resolveTarget(ctx.pool, input.kind, input.id, user.userId);
  if (!target) throw new DomainError('NOT_FOUND', 'Nothing to report here.');
  if (target.ownerUserId === user.userId) throw new DomainError('VALIDATION_FAILED', 'You can’t report your own content.');
  try {
    const r = await one<{ id: string }>(
      ctx.pool,
      `INSERT INTO reports (reporter_user_id, target_kind, target_id, reason, details) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user.userId, input.kind, input.id, input.reason, input.details],
    );
    return { reportId: r.id };
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError('CONFLICT', 'You’ve already reported this. Our team will review it.');
    throw err;
  }
}

export interface ReportQueueItem {
  id: string;
  kind: ReportKind;
  targetId: string;
  targetLabel: string;
  reason: ReportReason;
  reasonLabel: string;
  details: string;
  status: string;
  createdAt: string;
  openReportsOnTarget: number;
  allowedActions: ModerationActionKind[];
  resolutionNote: string | null;
}

const ACTIONS_FOR: Record<ReportKind, ModerationActionKind[]> = {
  listing: ['remove_listing', 'suspend_shop', 'dismiss'],
  shop: ['suspend_shop', 'dismiss'],
  user: ['suspend_user', 'dismiss'],
  message: ['hide_message', 'suspend_user', 'dismiss'],
  review: ['hide_review', 'suspend_user', 'dismiss'],
};

/** Trust & safety queue: open reports first, with how many reports the same target has. */
export async function staffReportQueue(ctx: AppContext, opts: { status?: string } = {}): Promise<ReportQueueItem[]> {
  requireStaff(ctx, 'trust_safety', 'admin');
  const status = opts.status === 'closed' ? `status IN ('actioned','dismissed')` : `status = 'open'`;
  const rows = await many<{ id: string; target_kind: ReportKind; target_id: string; reason: ReportReason; details: string; status: string; created_at: Date; n: number; resolution_note: string | null }>(
    ctx.pool,
    `SELECT r.id, r.target_kind, r.target_id, r.reason, r.details, r.status, r.created_at, r.resolution_note,
            (SELECT count(*) FROM reports x WHERE x.target_kind = r.target_kind AND x.target_id = r.target_id AND x.status = 'open')::int AS n
       FROM reports r WHERE ${status} ORDER BY n DESC, r.created_at LIMIT 200`,
  );
  const out: ReportQueueItem[] = [];
  for (const r of rows) {
    const t = await resolveTarget(ctx.pool, r.target_kind, r.target_id, null);
    out.push({
      id: r.id,
      kind: r.target_kind,
      targetId: r.target_id,
      targetLabel: t?.label ?? `${r.target_kind} (no longer available)`,
      reason: r.reason,
      reasonLabel: REPORT_REASON_LABEL[r.reason],
      details: r.details,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
      openReportsOnTarget: r.n,
      allowedActions: ACTIONS_FOR[r.target_kind],
      resolutionNote: r.resolution_note,
    });
  }
  return out;
}

async function notifyAffected(tx: Queryable, userId: string | null, title: string, reason: string, key: string): Promise<void> {
  if (!userId) return;
  await notifyUser(tx, {
    userId,
    topic: 'transactional',
    kind: 'moderation_notice',
    title,
    body: `Reason: ${reason}. If you believe this is a mistake, contact support from the help page to appeal.`,
    link: '/help',
    dedupeKey: key,
  });
}

/**
 * Acts on a report (trust & safety): the action must fit the target, a reason is mandatory, the affected person is
 * told why and how to appeal, and every action is recorded for audit. Other open reports on the target close too.
 */
export async function actOnReport(ctx: AppContext, raw: unknown): Promise<{ reportId: string; action: ModerationActionKind; moderationActionId: string | null }> {
  const staff = requireStaff(ctx, 'trust_safety', 'admin');
  const input = parseInput(actOnReportInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const report = await maybeOne<{ id: string; target_kind: ReportKind; target_id: string; status: string; reporter_user_id: string }>(
      tx,
      'SELECT id, target_kind, target_id, status, reporter_user_id FROM reports WHERE id = $1 FOR UPDATE',
      [input.reportId],
    );
    if (!report) throw new DomainError('NOT_FOUND', 'Report not found.');
    if (report.status !== 'open') throw new DomainError('INVALID_STATE', 'This report has already been handled.');
    if (!ACTIONS_FOR[report.target_kind].includes(input.action)) throw new DomainError('VALIDATION_FAILED', 'That action doesn’t apply to this kind of report.');
    const target = await resolveTarget(tx, report.target_kind, report.target_id, null);
    // Conflict of interest: nobody handles a report they filed or one about their own account, shop or content.
    const involved =
      report.reporter_user_id === staff.userId ||
      target?.ownerUserId === staff.userId ||
      (report.target_kind === 'user' && report.target_id === staff.userId) ||
      (!!target?.shopId && !!(await maybeOne(tx, 'SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2', [target.shopId, staff.userId])));
    if (involved) throw new DomainError('FORBIDDEN', 'You filed this report or it concerns you, so another team member must handle it.');
    let actionId: string | null = null;
    const record = async (kind: string, id: string, action: string) => {
      const m = await one<{ id: string }>(
        tx,
        `INSERT INTO moderation_actions (actor_user_id, target_kind, target_id, action, reason, report_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [staff.userId, kind, id, action, input.reason, report.id],
      );
      actionId = m.id;
      await recordAudit(tx, ctx, { action: `moderation.${action}`, targetKind: kind, targetId: id, reason: input.reason, data: { reportId: report.id } });
    };
    if (input.action !== 'dismiss' && !target) throw new DomainError('INVALID_STATE', 'The reported item no longer exists. Dismiss the report instead.');
    switch (input.action) {
      case 'remove_listing': {
        // Lock order: auctions before stock. A running auction is stopped first so nothing can still sell the piece.
        await stopOpenAuctions(tx, { listingId: report.target_id, reason: input.reason, actorUserId: staff.userId, now: ctx.now() });
        const stock = await maybeOne<{ quantity_available: number }>(tx, 'SELECT quantity_available FROM inventory_stock WHERE listing_id = $1', [report.target_id]);
        if (stock && stock.quantity_available > 0) {
          await withdrawStock(tx, { listingId: report.target_id, quantity: stock.quantity_available, reason: 'moderation_removed', actorUserId: staff.userId });
        }
        await tx.query(`UPDATE listings SET status = 'removed', updated_at = now() WHERE id = $1`, [report.target_id]);
        await tx.query(`UPDATE ad_campaigns SET status = 'ended', ended_at = least(now(), ends_at), end_reason = 'listing_removed', updated_at = now() WHERE listing_id = $1 AND status IN ('scheduled','active','paused')`, [report.target_id]);
        await enqueue(tx, { topic: 'listing.ended', aggregateId: report.target_id, payload: { listingId: report.target_id, shopId: target!.shopId, reason: 'moderation' }, dedupeKey: `listing.ended:${report.target_id}:moderation` });
        await record('listing', report.target_id, 'remove_listing');
        await notifyAffected(tx, target!.ownerUserId, 'A listing of yours was removed', input.reason, `mod:${actionId}`);
        break;
      }
      case 'suspend_shop': {
        const shopId = target!.shopId!;
        await tx.query(`UPDATE shops SET status = 'suspended', updated_at = now() WHERE id = $1`, [shopId]);
        // A suspended shop takes no new sales: its scheduled and live auctions stop (bidders are never charged).
        await stopOpenAuctions(tx, { shopId, reason: input.reason, actorUserId: staff.userId, now: ctx.now() });
        await tx.query(`UPDATE ad_campaigns SET status = 'ended', ended_at = least(now(), ends_at), end_reason = 'shop_suspended', updated_at = now() WHERE shop_id = $1 AND status IN ('scheduled','active','paused')`, [shopId]);
        await record('shop', shopId, 'suspend_shop');
        const owner = await one<{ owner_user_id: string }>(tx, 'SELECT owner_user_id FROM shops WHERE id = $1', [shopId]);
        await notifyAffected(tx, owner.owner_user_id, 'Your shop has been suspended', `${input.reason}. Existing paid orders must still be fulfilled`, `mod:${actionId}`);
        break;
      }
      case 'hide_message':
        await tx.query(`UPDATE messages SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL`, [report.target_id]);
        await record('message', report.target_id, 'hide_message');
        await notifyAffected(tx, target!.ownerUserId, 'A message you sent was hidden', input.reason, `mod:${actionId}`);
        break;
      case 'hide_review':
        await applyReviewModeration(tx, ctx, staff.userId, { reviewId: report.target_id, action: 'hide', reason: input.reason }, report.id);
        actionId = (await one<{ id: string }>(tx, `SELECT id FROM moderation_actions WHERE report_id = $1 ORDER BY created_at DESC LIMIT 1`, [report.id])).id;
        break;
      case 'suspend_user': {
        const userId = target!.ownerUserId;
        if (!userId) throw new DomainError('INVALID_STATE', 'There is no account to suspend for this report.');
        await tx.query(`UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1`, [userId]);
        await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
        await record('user', userId, 'suspend_user');
        await notifyAffected(tx, userId, 'Your account has been suspended', input.reason, `mod:${actionId}`);
        break;
      }
      case 'dismiss':
        await recordAudit(tx, ctx, { action: 'report.dismissed', targetKind: 'report', targetId: report.id, reason: input.reason });
        break;
    }
    const status = input.action === 'dismiss' ? 'dismissed' : 'actioned';
    await tx.query(`UPDATE reports SET status = $2, handled_by = $3, handled_at = now(), resolution_note = $4 WHERE id = $1`, [report.id, status, staff.userId, input.reason]);
    if (status === 'actioned') {
      await tx.query(
        `UPDATE reports SET status = 'actioned', handled_by = $3, handled_at = now(), resolution_note = $4 WHERE target_kind = $1 AND target_id = $2 AND status = 'open'`,
        [report.target_kind, report.target_id, staff.userId, `Handled with report ${report.id}: ${input.reason}`],
      );
    }
    return { reportId: report.id, action: input.action, moderationActionId: actionId };
  });
}

/** Appeal handling: staff reverse a moderation action with a reason (audited; the affected person is told). */
export async function reverseModerationAction(ctx: AppContext, raw: unknown): Promise<{ actionId: string }> {
  const staff = requireStaff(ctx, 'trust_safety', 'admin');
  const input = parseInput(reverseModerationInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const a = await maybeOne<{ id: string; target_kind: string; target_id: string; action: string }>(tx, 'SELECT id, target_kind, target_id, action FROM moderation_actions WHERE id = $1', [input.actionId]);
    if (!a) throw new DomainError('NOT_FOUND', 'Moderation action not found.');
    let affected: string | null = null;
    switch (a.action) {
      case 'remove_listing':
        // Stock was withdrawn; the seller republishes from drafts after restocking.
        await tx.query(`UPDATE listings SET status = 'draft', updated_at = now() WHERE id = $1 AND status = 'removed'`, [a.target_id]);
        affected = (await maybeOne<{ owner_user_id: string }>(tx, 'SELECT s.owner_user_id FROM listings l JOIN shops s ON s.id = l.shop_id WHERE l.id = $1', [a.target_id]))?.owner_user_id ?? null;
        break;
      case 'suspend_shop':
        await tx.query(`UPDATE shops SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'suspended'`, [a.target_id]);
        affected = (await maybeOne<{ owner_user_id: string }>(tx, 'SELECT owner_user_id FROM shops WHERE id = $1', [a.target_id]))?.owner_user_id ?? null;
        break;
      case 'hide_message':
        await tx.query(`UPDATE messages SET hidden_at = NULL WHERE id = $1`, [a.target_id]);
        affected = (await maybeOne<{ sender_user_id: string | null }>(tx, 'SELECT sender_user_id FROM messages WHERE id = $1', [a.target_id]))?.sender_user_id ?? null;
        break;
      case 'review_hide':
      case 'review_remove':
        await applyReviewModeration(tx, ctx, staff.userId, { reviewId: a.target_id, action: 'restore', reason: input.reason }, null);
        break;
      case 'suspend_user':
        await tx.query(`UPDATE users SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'suspended'`, [a.target_id]);
        affected = a.target_id;
        break;
      default:
        throw new DomainError('INVALID_STATE', 'This action can’t be reversed.');
    }
    await tx.query(`INSERT INTO moderation_actions (actor_user_id, target_kind, target_id, action, reason) VALUES ($1, $2, $3, $4, $5)`, [
      staff.userId,
      a.target_kind,
      a.target_id,
      `reverse_${a.action}`,
      input.reason,
    ]);
    await recordAudit(tx, ctx, { action: `moderation.reverse_${a.action}`, targetKind: a.target_kind, targetId: a.target_id, reason: input.reason, data: { reversedActionId: a.id } });
    if (affected) {
      await notifyUser(tx, { userId: affected, topic: 'transactional', kind: 'moderation_reversed', title: 'A moderation decision was reversed', body: input.reason, link: '/help', dedupeKey: `mod-reverse:${a.id}` });
    }
    return { actionId: a.id };
  });
}

/** Recent moderation actions (for reversal on appeal). */
export async function recentModerationActions(ctx: AppContext): Promise<{ id: string; targetKind: string; targetId: string; action: string; reason: string; createdAt: string }[]> {
  requireStaff(ctx, 'trust_safety', 'admin');
  const rows = await many<{ id: string; target_kind: string; target_id: string; action: string; reason: string; created_at: Date }>(
    ctx.pool,
    `SELECT id, target_kind, target_id, action, reason, created_at FROM moderation_actions ORDER BY created_at DESC LIMIT 50`,
  );
  return rows.map((r) => ({ id: r.id, targetKind: r.target_kind, targetId: r.target_id, action: r.action, reason: r.reason, createdAt: new Date(r.created_at).toISOString() }));
}
