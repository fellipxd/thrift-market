import { DomainError, formatWatDate } from '@thrift/domain';
import { isUniqueViolation, many, maybeOne, one, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireOwnShop, requireStaff, requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { parseInput } from '../core/validation';
import { signMediaUrl } from '../media/media';
import { notifyUser } from '../notifications/notify';
import { decideVerificationInput, ID_TYPE_LABEL, submitVerificationInput } from './inputs';

export type VerificationKind = 'identity' | 'business' | 'reverification';
export type VerificationCaseStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/** What the public badge means. It is about who runs the shop, never about item authenticity. */
export const VERIFICATION_EXPLAINER =
  'An identity check confirms who runs this shop, using an official document reviewed by our trust & safety team. It does not certify that items are authentic or guarantee the seller’s service — check the service history and reviews for that.';

/**
 * Seller submits identity (or business) evidence. Evidence photos must be uploaded with purpose
 * 'verification_evidence' (restricted media, served only through short-lived signed URLs to staff).
 * Only the last 4 characters of the document number are stored. One pending case per shop.
 */
export async function submitVerification(ctx: AppContext, raw: unknown): Promise<{ caseId: string; status: 'pending' }> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(submitVerificationInput, raw);
  await enforceRateLimit(ctx.pool, `verification-submit:${user.userId}`, 5, 86_400);
  const shop = await requireOwnShop(ctx.pool, ctx);
  const media = await many<{ id: string }>(
    ctx.pool,
    `SELECT id FROM media_assets WHERE id = ANY($1::uuid[]) AND owner_user_id = $2 AND purpose = 'verification_evidence' AND status = 'ready'`,
    [input.evidenceMediaIds, user.userId],
  );
  if (media.length !== input.evidenceMediaIds.length) {
    throw new DomainError('NOT_FOUND', 'One of the document photos was not found. Upload it again.', {
      fieldErrors: { evidenceMediaIds: 'Upload the document photos again.' },
    });
  }
  try {
    return await withTransaction(ctx.pool, async (tx) => {
      const s = await one<{ verification_status: string }>(tx, `SELECT verification_status FROM shops WHERE id = $1 FOR UPDATE`, [shop.id]);
      if (s.verification_status === 'approved') throw new DomainError('INVALID_STATE', 'Your shop is already verified.');
      if (s.verification_status === 'suspended') throw new DomainError('INVALID_STATE', 'Verification is suspended for this shop. Contact support.');
      const pending = await maybeOne(tx, `SELECT id FROM verification_cases WHERE shop_id = $1 AND status = 'pending'`, [shop.id]);
      if (pending) throw new DomainError('CONFLICT', 'You already have a verification case under review.');
      const kind: VerificationKind =
        input.idType === 'cac_registration' ? 'business' : s.verification_status === 'reverification' ? 'reverification' : 'identity';
      const c = await one<{ id: string }>(
        tx,
        `INSERT INTO verification_cases (shop_id, kind, status, legal_name, id_type, id_number_last4, evidence_media_ids, submitted_by)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7) RETURNING id`,
        [shop.id, kind, input.legalName, input.idType, input.idNumberLast4.toUpperCase(), input.evidenceMediaIds, user.userId],
      );
      await tx.query(`UPDATE shops SET verification_status = 'pending', updated_at = now() WHERE id = $1`, [shop.id]);
      await recordAudit(tx, ctx, {
        action: 'verification.submitted',
        targetKind: 'verification_case',
        targetId: c.id,
        data: { shopId: shop.id, kind, idType: input.idType, evidenceCount: input.evidenceMediaIds.length },
      });
      return { caseId: c.id, status: 'pending' as const };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'verification_cases_one_pending')) {
      throw new DomainError('CONFLICT', 'You already have a verification case under review.');
    }
    throw err;
  }
}

export interface OwnVerificationView {
  shopVerificationStatus: string;
  verifiedAt: string | null;
  verificationLabel: string | null;
  canSubmit: boolean;
  latestCase: {
    id: string;
    kind: VerificationKind;
    status: VerificationCaseStatus;
    idTypeLabel: string | null;
    submittedAt: string;
    decidedAt: string | null;
    /** Shown to the seller only for rejections, so they know what to fix. */
    rejectionReason: string | null;
    evidenceCount: number;
  } | null;
}

export async function getOwnVerification(ctx: AppContext): Promise<OwnVerificationView> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const s = await one<{ verification_status: string; verified_at: Date | null; verification_label: string | null }>(
    ctx.pool,
    `SELECT verification_status, verified_at, verification_label FROM shops WHERE id = $1`,
    [shop.id],
  );
  const c = await maybeOne<{
    id: string;
    kind: VerificationKind;
    status: VerificationCaseStatus;
    id_type: keyof typeof ID_TYPE_LABEL | null;
    submitted_at: Date;
    decided_at: Date | null;
    decision_reason: string | null;
    evidence_count: number;
  }>(
    ctx.pool,
    `SELECT id, kind, status, id_type, submitted_at, decided_at, decision_reason, cardinality(evidence_media_ids) AS evidence_count
       FROM verification_cases WHERE shop_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
    [shop.id],
  );
  return {
    shopVerificationStatus: s.verification_status,
    verifiedAt: s.verified_at ? new Date(s.verified_at).toISOString() : null,
    verificationLabel: s.verification_label,
    canSubmit: ['unverified', 'rejected', 'reverification'].includes(s.verification_status) && c?.status !== 'pending',
    latestCase: c
      ? {
          id: c.id,
          kind: c.kind,
          status: c.status,
          idTypeLabel: c.id_type ? ID_TYPE_LABEL[c.id_type] : null,
          submittedAt: new Date(c.submitted_at).toISOString(),
          decidedAt: c.decided_at ? new Date(c.decided_at).toISOString() : null,
          rejectionReason: c.status === 'rejected' ? c.decision_reason : null,
          evidenceCount: c.evidence_count,
        }
      : null,
  };
}

export interface VerificationQueueItem {
  caseId: string;
  shopId: string;
  shopName: string;
  shopSlug: string;
  kind: VerificationKind;
  submittedAt: string;
  ageHours: number;
  evidenceCount: number;
}

/** Trust & safety queue: pending cases, oldest first. */
export async function listVerificationQueue(ctx: AppContext, opts: { limit?: number } = {}): Promise<{ pending: VerificationQueueItem[]; recentlyDecided: { caseId: string; shopName: string; status: string; decidedAt: string; decidedBy: string | null }[] }> {
  requireStaff(ctx, 'trust_safety', 'admin');
  const rows = await many<{ id: string; shop_id: string; name: string; slug: string; kind: VerificationKind; submitted_at: Date; evidence_count: number }>(
    ctx.pool,
    `SELECT v.id, v.shop_id, s.name, s.slug, v.kind, v.submitted_at, cardinality(v.evidence_media_ids) AS evidence_count
       FROM verification_cases v JOIN shops s ON s.id = v.shop_id
      WHERE v.status = 'pending' ORDER BY v.submitted_at ASC, v.id LIMIT $1`,
    [Math.min(opts.limit ?? 100, 200)],
  );
  const decided = await many<{ id: string; name: string; status: string; decided_at: Date; decided_by_name: string | null }>(
    ctx.pool,
    `SELECT v.id, s.name, v.status, v.decided_at, u.display_name AS decided_by_name
       FROM verification_cases v JOIN shops s ON s.id = v.shop_id LEFT JOIN users u ON u.id = v.decided_by
      WHERE v.status IN ('approved','rejected') ORDER BY v.decided_at DESC LIMIT 10`,
  );
  const now = ctx.now().getTime();
  return {
    pending: rows.map((r) => ({
      caseId: r.id,
      shopId: r.shop_id,
      shopName: r.name,
      shopSlug: r.slug,
      kind: r.kind,
      submittedAt: new Date(r.submitted_at).toISOString(),
      ageHours: Math.max(0, Math.floor((now - new Date(r.submitted_at).getTime()) / 3_600_000)),
      evidenceCount: r.evidence_count,
    })),
    recentlyDecided: decided.map((d) => ({
      caseId: d.id,
      shopName: d.name,
      status: d.status,
      decidedAt: new Date(d.decided_at).toISOString(),
      decidedBy: d.decided_by_name,
    })),
  };
}

export interface VerificationCaseDetail {
  caseId: string;
  kind: VerificationKind;
  status: VerificationCaseStatus;
  legalName: string;
  idType: string | null;
  idTypeLabel: string | null;
  idNumberLast4: string | null;
  submittedAt: string;
  submittedBy: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  /** Short-lived signed URLs; restricted media is never served without a signature. */
  evidence: { mediaId: string; url: string; thumbUrl: string; expiresInSeconds: number }[];
  shop: { id: string; name: string; slug: string; city: string; state: string; ownerName: string; createdAt: string; verificationStatus: string; contactVerified: boolean };
  history: { caseId: string; status: string; submittedAt: string; decisionReason: string | null }[];
  canDecide: boolean;
}

/** Staff case view. Every view of restricted evidence is recorded in the audit log. */
export async function getVerificationCase(ctx: AppContext, caseId: string): Promise<VerificationCaseDetail> {
  const staff = requireStaff(ctx, 'trust_safety', 'admin');
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new DomainError('NOT_FOUND', 'Case not found.');
  const c = await maybeOne<{
    id: string;
    kind: VerificationKind;
    status: VerificationCaseStatus;
    legal_name: string;
    id_type: keyof typeof ID_TYPE_LABEL | null;
    id_number_last4: string | null;
    evidence_media_ids: string[];
    submitted_at: Date;
    submitted_by: string;
    submitted_by_name: string;
    decided_at: Date | null;
    decided_by_name: string | null;
    decision_reason: string | null;
    shop_id: string;
    shop_name: string;
    slug: string;
    city: string;
    state: string;
    shop_created_at: Date;
    verification_status: string;
    owner_name: string;
    owner_verified: boolean;
  }>(
    ctx.pool,
    `SELECT v.id, v.kind, v.status, v.legal_name, v.id_type, v.id_number_last4, v.evidence_media_ids, v.submitted_at, v.submitted_by,
            su.display_name AS submitted_by_name, v.decided_at, du.display_name AS decided_by_name, v.decision_reason,
            s.id AS shop_id, s.name AS shop_name, s.slug, s.city, s.state, s.created_at AS shop_created_at, s.verification_status,
            o.display_name AS owner_name, (o.email_verified_at IS NOT NULL OR o.phone_verified_at IS NOT NULL) AS owner_verified
       FROM verification_cases v
       JOIN shops s ON s.id = v.shop_id
       JOIN users o ON o.id = s.owner_user_id
       JOIN users su ON su.id = v.submitted_by
       LEFT JOIN users du ON du.id = v.decided_by
      WHERE v.id = $1`,
    [caseId],
  );
  if (!c) throw new DomainError('NOT_FOUND', 'Case not found.');
  const media = await many<{ id: string; storage_key: string }>(
    ctx.pool,
    `SELECT id, storage_key FROM media_assets WHERE id = ANY($1::uuid[]) AND purpose = 'verification_evidence'`,
    [c.evidence_media_ids],
  );
  const ttl = 600;
  const history = await many<{ id: string; status: string; submitted_at: Date; decision_reason: string | null }>(
    ctx.pool,
    `SELECT id, status, submitted_at, decision_reason FROM verification_cases WHERE shop_id = $1 AND id <> $2 ORDER BY submitted_at DESC LIMIT 10`,
    [c.shop_id, c.id],
  );
  await recordAudit(ctx.pool, ctx, {
    action: 'verification.evidence_viewed',
    targetKind: 'verification_case',
    targetId: c.id,
    data: { shopId: c.shop_id, evidenceCount: media.length },
  });
  return {
    caseId: c.id,
    kind: c.kind,
    status: c.status,
    legalName: c.legal_name,
    idType: c.id_type,
    idTypeLabel: c.id_type ? ID_TYPE_LABEL[c.id_type] : null,
    idNumberLast4: c.id_number_last4,
    submittedAt: new Date(c.submitted_at).toISOString(),
    submittedBy: c.submitted_by_name,
    decidedAt: c.decided_at ? new Date(c.decided_at).toISOString() : null,
    decidedBy: c.decided_by_name,
    decisionReason: c.decision_reason,
    evidence: c.evidence_media_ids
      .map((id) => media.find((m) => m.id === id))
      .filter((m): m is { id: string; storage_key: string } => Boolean(m))
      .map((m) => ({
        mediaId: m.id,
        url: signMediaUrl(ctx, m.storage_key, ttl),
        thumbUrl: signMediaUrl(ctx, m.storage_key, ttl, 'thumb'),
        expiresInSeconds: ttl,
      })),
    shop: {
      id: c.shop_id,
      name: c.shop_name,
      slug: c.slug,
      city: c.city,
      state: c.state,
      ownerName: c.owner_name,
      createdAt: new Date(c.shop_created_at).toISOString(),
      verificationStatus: c.verification_status,
      contactVerified: c.owner_verified,
    },
    history: history.map((h) => ({ caseId: h.id, status: h.status, submittedAt: new Date(h.submitted_at).toISOString(), decisionReason: h.decision_reason })),
    canDecide: c.status === 'pending' && c.submitted_by !== staff.userId,
  };
}

/**
 * Staff decision (trust_safety or admin) with a mandatory reason. Approval sets a dated, plain-language
 * label on the shop ("Identity checked on 12 Oct 2026"). Staff cannot decide a case they submitted.
 */
export async function decideVerification(ctx: AppContext, raw: unknown): Promise<{ caseId: string; status: 'approved' | 'rejected' }> {
  const staff = requireStaff(ctx, 'trust_safety', 'admin');
  const input = parseInput(decideVerificationInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const c = await maybeOne<{ id: string; shop_id: string; status: string; kind: VerificationKind; submitted_by: string }>(
      tx,
      `SELECT id, shop_id, status, kind, submitted_by FROM verification_cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    if (!c) throw new DomainError('NOT_FOUND', 'Case not found.');
    if (c.status !== 'pending') throw new DomainError('INVALID_STATE', 'This case has already been decided.');
    if (c.submitted_by === staff.userId) throw new DomainError('FORBIDDEN', 'You cannot decide a verification case for your own shop.');
    const owner = await one<{ owner_user_id: string }>(tx, `SELECT owner_user_id FROM shops WHERE id = $1 FOR UPDATE`, [c.shop_id]);
    if (owner.owner_user_id === staff.userId) throw new DomainError('FORBIDDEN', 'You cannot decide a verification case for your own shop.');
    const now = ctx.now();
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    await tx.query(
      `UPDATE verification_cases SET status = $2, decided_by = $3, decided_at = $4, decision_reason = $5 WHERE id = $1`,
      [c.id, status, staff.userId, now, input.reason],
    );
    if (status === 'approved') {
      const what = c.kind === 'business' ? 'Business registration checked' : 'Identity checked';
      await tx.query(
        `UPDATE shops SET verification_status = 'approved', verified_at = $2, verification_label = $3, updated_at = now() WHERE id = $1`,
        [c.shop_id, now, `${what} on ${formatWatDate(now)}`],
      );
    } else {
      await tx.query(
        `UPDATE shops SET verification_status = 'rejected', verified_at = NULL, verification_label = NULL, updated_at = now() WHERE id = $1`,
        [c.shop_id],
      );
    }
    await recordAudit(tx, ctx, {
      action: status === 'approved' ? 'verification.approved' : 'verification.rejected',
      targetKind: 'verification_case',
      targetId: c.id,
      reason: input.reason,
      data: { shopId: c.shop_id, kind: c.kind },
    });
    await notifyUser(tx, {
      userId: owner.owner_user_id,
      topic: 'transactional',
      kind: status === 'approved' ? 'verification_approved' : 'verification_rejected',
      title: status === 'approved' ? 'Your shop’s identity check is complete' : 'Your verification was not approved',
      body: status === 'approved' ? 'Your shop now shows a dated “Identity checked” note.' : `Reason: ${input.reason} You can submit new evidence from your seller workspace.`,
      link: '/sell/verification',
      dedupeKey: `verification:${c.id}:decided`,
    });
    return { caseId: c.id, status };
  });
}
