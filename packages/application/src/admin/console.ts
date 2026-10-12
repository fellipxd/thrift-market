import { auditSearchInput, grantRoleInput, publishPolicyInput, replayWebhookInput, retryOutboxInput, revokeRoleInput, updateSettingInput, type StaffRoleName } from '@thrift/contracts';
import { DEFAULT_SETTINGS, DomainError, type SettingKey } from '@thrift/domain';
import { many, maybeOne, one, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { hasRole, requireStaff } from '../core/authz';
import type { AppContext } from '../core/context';
import { clearSettingsCache, getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { listTasks } from '../jobs/tasks';
import { SETTING_META } from './settings-meta';

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface AdminOverview {
  counts: { key: string; label: string; count: number; href: string; urgent: boolean }[];
  worker: { lastRunAt: string | null; stale: boolean; staleTasks: string[] };
}

/** Operational counts for any staff role, each linking to where it's handled. */
export async function adminOverview(ctx: AppContext): Promise<AdminOverview> {
  requireStaff(ctx, 'support', 'trust_safety', 'finance', 'admin');
  const c = await one<Record<string, number>>(
    ctx.pool,
    `SELECT
       (SELECT count(*) FROM verification_cases WHERE status = 'pending')::int AS verifications,
       (SELECT count(*) FROM reports WHERE status = 'open')::int AS reports,
       (SELECT count(*) FROM disputes WHERE status IN ('under_review','appealed'))::int AS disputes,
       (SELECT count(*) FROM refunds WHERE status = 'requested')::int AS refunds,
       (SELECT count(*) FROM payment_attempts WHERE status IN ('uncertain') OR (status IN ('initiated','pending') AND created_at < now() - interval '30 minutes' AND created_at > now() - interval '7 days'))::int AS payments,
       (SELECT count(*) FROM webhook_inbox WHERE status = 'failed')::int AS webhooks,
       (SELECT count(*) FROM ad_campaigns WHERE status = 'pending_review')::int AS ads,
       (SELECT count(*) FROM auctions WHERE status IN ('live','scheduled') AND ends_at < now() - interval '2 minutes')::int AS auctions,
       (SELECT count(*) FROM reservations WHERE (status = 'active' AND expires_at < now() - interval '5 minutes') OR (status = 'payment_pending' AND grace_until < now() - interval '5 minutes'))::int AS reservations,
       (SELECT count(*) FROM outbox_events WHERE status = 'dead')::int AS dead_events`,
  );
  const ops = await workerHealth(ctx);
  const item = (key: string, label: string, href: string, urgent = false) => ({ key, label, count: c[key] ?? 0, href, urgent: urgent && (c[key] ?? 0) > 0 });
  return {
    counts: [
      item('verifications', 'Seller verifications to review', '/admin/verification'),
      item('reports', 'Open reports', '/admin/reports'),
      item('disputes', 'Disputes awaiting a decision', '/admin/disputes', true),
      item('refunds', 'Refunds awaiting approval', '/admin/finance', true),
      item('payments', 'Uncertain or late payments', '/admin/finance', true),
      item('webhooks', 'Failed webhooks', '/admin/operations', true),
      item('ads', 'Promotions awaiting review', '/admin/ads'),
      item('auctions', 'Auctions overdue for finalising', '/admin/operations', true),
      item('reservations', 'Holds overdue for reconciliation', '/admin/operations', true),
      item('dead_events', 'Dead-lettered background events', '/admin/operations', true),
    ],
    worker: { lastRunAt: ops.lastRunAt, stale: ops.staleTasks.length > 0 || ops.lastRunAt === null, staleTasks: ops.staleTasks },
  };
}

async function workerHealth(ctx: AppContext): Promise<{ lastRunAt: string | null; staleTasks: string[]; beats: { task: string; workerId: string; lastRunAt: string; status: string; stale: boolean; detail: Record<string, unknown> }[] }> {
  const beats = await many<{ worker_id: string; task: string; last_run_at: Date; last_status: string; detail: Record<string, unknown> }>(
    ctx.pool,
    `SELECT DISTINCT ON (task) worker_id, task, last_run_at, last_status, detail FROM worker_heartbeats ORDER BY task, last_run_at DESC`,
  );
  const now = ctx.now().getTime();
  const intervals = new Map(listTasks().map((t) => [t.name, t.intervalMs]));
  const rows = beats.map((b) => {
    const interval = intervals.get(b.task) ?? 60_000;
    const stale = now - new Date(b.last_run_at).getTime() > Math.max(interval * 3, 60_000);
    return { task: b.task, workerId: b.worker_id, lastRunAt: new Date(b.last_run_at).toISOString(), status: b.last_status, stale, detail: b.detail };
  });
  const seen = new Set(rows.map((r) => r.task));
  const missing = [...intervals.keys()].filter((t) => !seen.has(t));
  const last = rows.reduce<number | null>((m, r) => Math.max(m ?? 0, new Date(r.lastRunAt).getTime()), null);
  return { lastRunAt: last ? new Date(last).toISOString() : null, staleTasks: [...rows.filter((r) => r.stale || r.status === 'error').map((r) => r.task), ...missing], beats: rows };
}

// ---------------------------------------------------------------------------
// Operations (admin only)
// ---------------------------------------------------------------------------

export interface OperationsStatus {
  heartbeats: Awaited<ReturnType<typeof workerHealth>>['beats'];
  missingTasks: string[];
  outbox: { status: string; count: number }[];
  deadEvents: { id: number; topic: string; attempts: number; lastError: string | null; createdAt: string }[];
  failedWebhooks: { id: string; provider: string; eventType: string; attempts: number; lastError: string | null; receivedAt: string }[];
  overdueAuctions: { id: string; endsAt: string }[];
  overdueReservations: { id: string; status: string; expiresAt: string }[];
}

export async function operationsStatus(ctx: AppContext): Promise<OperationsStatus> {
  requireStaff(ctx, 'admin');
  const health = await workerHealth(ctx);
  const [outbox, dead, webhooks, auctions, reservations] = await Promise.all([
    many<{ status: string; count: number }>(ctx.pool, `SELECT status, count(*)::int AS count FROM outbox_events WHERE status <> 'done' GROUP BY status ORDER BY status`),
    many<{ id: number; topic: string; attempts: number; last_error: string | null; created_at: Date }>(
      ctx.pool,
      `SELECT id, topic, attempts, last_error, created_at FROM outbox_events WHERE status = 'dead' ORDER BY id DESC LIMIT 50`,
    ),
    many<{ id: string; provider: string; event_type: string; attempts: number; last_error: string | null; received_at: Date }>(
      ctx.pool,
      `SELECT id, provider, event_type, attempts, last_error, received_at FROM webhook_inbox WHERE status = 'failed' ORDER BY received_at DESC LIMIT 50`,
    ),
    many<{ id: string; ends_at: Date }>(ctx.pool, `SELECT id, ends_at FROM auctions WHERE status IN ('live','scheduled') AND ends_at < now() - interval '2 minutes' ORDER BY ends_at LIMIT 50`),
    many<{ id: string; status: string; expires_at: Date }>(
      ctx.pool,
      `SELECT id, status, expires_at FROM reservations WHERE (status = 'active' AND expires_at < now() - interval '5 minutes') OR (status = 'payment_pending' AND grace_until < now() - interval '5 minutes') ORDER BY expires_at LIMIT 50`,
    ),
  ]);
  const seen = new Set(health.beats.map((b) => b.task));
  return {
    heartbeats: health.beats,
    missingTasks: listTasks().map((t) => t.name).filter((t) => !seen.has(t)),
    outbox,
    deadEvents: dead.map((d) => ({ id: Number(d.id), topic: d.topic, attempts: d.attempts, lastError: d.last_error, createdAt: new Date(d.created_at).toISOString() })),
    failedWebhooks: webhooks.map((w) => ({ id: w.id, provider: w.provider, eventType: w.event_type, attempts: w.attempts, lastError: w.last_error, receivedAt: new Date(w.received_at).toISOString() })),
    overdueAuctions: auctions.map((a) => ({ id: a.id, endsAt: new Date(a.ends_at).toISOString() })),
    overdueReservations: reservations.map((r) => ({ id: r.id, status: r.status, expiresAt: new Date(r.expires_at).toISOString() })),
  };
}

/** Puts a dead-lettered outbox event back in the queue (handlers are idempotent). Audited. */
export async function retryOutboxEvent(ctx: AppContext, raw: unknown): Promise<{ id: number }> {
  requireStaff(ctx, 'admin');
  const input = parseInput(retryOutboxInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const r = await tx.query(`UPDATE outbox_events SET status = 'pending', attempts = 0, available_at = now(), locked_until = NULL WHERE id = $1 AND status = 'dead'`, [input.id]);
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'No dead-lettered event with that id.');
    await recordAudit(tx, ctx, { action: 'ops.outbox_retry', targetKind: 'outbox_event', targetId: String(input.id), reason: input.reason });
    return { id: input.id };
  });
}

/** Replays a failed webhook through normal processing (re-verified with the provider). Audited. */
export async function replayWebhook(ctx: AppContext, raw: unknown): Promise<{ id: string }> {
  requireStaff(ctx, 'admin');
  const input = parseInput(replayWebhookInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const r = await tx.query(`UPDATE webhook_inbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1 AND status = 'failed'`, [input.id]);
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'No failed webhook with that id.');
    await recordAudit(tx, ctx, { action: 'ops.webhook_replay', targetKind: 'webhook', targetId: input.id, reason: input.reason });
    return { id: input.id };
  });
}

// ---------------------------------------------------------------------------
// Audit search
// ---------------------------------------------------------------------------

const FINANCE_ACTIONS = `(a.action LIKE 'refund.%' OR a.action LIKE 'payout%' OR a.action LIKE 'ledger.%' OR a.action LIKE 'finance.%' OR a.action LIKE 'payment%')`;

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  actorKind: string;
  actorName: string | null;
  targetKind: string;
  targetId: string | null;
  reason: string | null;
  data: Record<string, unknown>;
}

/** Searches the audit trail. Finance-sensitive actions are visible only to finance and admin. Keyset paged by id. */
export async function searchAudit(ctx: AppContext, raw: unknown = {}): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const staff = requireStaff(ctx, 'support', 'trust_safety', 'finance', 'admin');
  const input = parseInput(auditSearchInput, raw);
  const where: string[] = ['true'];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (input.action) add(`a.action ILIKE ?`, `${input.action.replace(/[%_]/g, '')}%`);
  if (input.targetKind) add(`a.target_kind = ?`, input.targetKind);
  if (input.targetId) add(`a.target_id = ?`, input.targetId);
  if (input.actorEmail) add(`lower(u.email) = lower(?)`, input.actorEmail);
  if (input.from && !Number.isNaN(Date.parse(input.from))) add(`a.created_at >= ?::timestamptz`, input.from);
  if (input.to && !Number.isNaN(Date.parse(input.to))) add(`a.created_at < ?::timestamptz + interval '1 day'`, input.to);
  if (input.before) add(`a.id < ?`, input.before);
  if (!hasRole(staff, 'finance', 'admin')) where.push(`NOT ${FINANCE_ACTIONS}`);
  const rows = await many<{ id: number; created_at: Date; action: string; actor_kind: string; actor_name: string | null; target_kind: string; target_id: string | null; reason: string | null; data: Record<string, unknown> }>(
    ctx.pool,
    `SELECT a.id, a.created_at, a.action, a.actor_kind, u.display_name AS actor_name, a.target_kind, a.target_id, a.reason, a.data
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.id DESC LIMIT 51`,
    params,
  );
  const page = rows.slice(0, 50);
  return {
    entries: page.map((r) => ({
      id: Number(r.id),
      at: new Date(r.created_at).toISOString(),
      action: r.action,
      actorKind: r.actor_kind,
      actorName: r.actor_name,
      targetKind: r.target_kind,
      targetId: r.target_id,
      reason: r.reason,
      data: r.data,
    })),
    nextBefore: rows.length > 50 ? Number(page[page.length - 1]!.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Settings and policies (admin)
// ---------------------------------------------------------------------------

export interface SettingView {
  key: SettingKey;
  label: string;
  description: string;
  unit: string;
  min: number;
  max: number;
  value: number;
  defaultValue: number;
  updatedAt: string | null;
}

export async function listSettings(ctx: AppContext): Promise<SettingView[]> {
  requireStaff(ctx, 'admin');
  const current = await getSettings(ctx.pool, { fresh: true });
  const rows = await many<{ key: string; updated_at: Date }>(ctx.pool, 'SELECT key, updated_at FROM platform_settings');
  return (Object.keys(DEFAULT_SETTINGS) as SettingKey[]).map((key) => ({
    key,
    ...SETTING_META[key],
    value: current[key],
    defaultValue: DEFAULT_SETTINGS[key],
    updatedAt: rows.find((r) => r.key === key)?.updated_at ? new Date(rows.find((r) => r.key === key)!.updated_at).toISOString() : null,
  }));
}

/** Changes one platform setting within its allowed range. Requires a reason; audited with old and new values. */
export async function updateSetting(ctx: AppContext, raw: unknown): Promise<{ key: SettingKey; value: number }> {
  const admin = requireStaff(ctx, 'admin');
  const input = parseInput(updateSettingInput, raw);
  if (!(input.key in DEFAULT_SETTINGS)) throw new DomainError('VALIDATION_FAILED', 'Unknown setting.');
  const key = input.key as SettingKey;
  const meta = SETTING_META[key];
  if (!Number.isInteger(input.value) || input.value < meta.min || input.value > meta.max) {
    throw new DomainError('VALIDATION_FAILED', `${meta.label} must be a whole number between ${meta.min} and ${meta.max} ${meta.unit}.`, { fieldErrors: { value: `Between ${meta.min} and ${meta.max}.` } });
  }
  return withTransaction(ctx.pool, async (tx) => {
    const old = (await getSettings(tx, { fresh: true }))[key];
    await tx.query(
      `INSERT INTO platform_settings (key, value, description, updated_at, updated_by) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(input.value), meta.description, admin.userId],
    );
    await recordAudit(tx, ctx, { action: 'settings.updated', targetKind: 'setting', targetId: key, reason: input.reason, data: { from: old, to: input.value } });
    clearSettingsCache();
    return { key, value: input.value };
  });
}

export async function listPolicies(ctx: AppContext): Promise<{ id: string; kind: string; version: string; title: string; effectiveAt: string; current: boolean }[]> {
  requireStaff(ctx, 'admin');
  const rows = await many<{ id: string; kind: string; version: string; title: string; effective_at: Date; current: boolean }>(
    ctx.pool,
    `SELECT p.id, p.kind, p.version, p.title, p.effective_at,
            p.id = (SELECT x.id FROM policy_versions x WHERE x.kind = p.kind AND x.effective_at <= now() ORDER BY x.effective_at DESC LIMIT 1) AS current
       FROM policy_versions p ORDER BY p.kind, p.effective_at DESC`,
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, version: r.version, title: r.title, effectiveAt: new Date(r.effective_at).toISOString(), current: r.current }));
}

/** Publishes a new policy version (effective now). Orders keep the versions they were placed under. Audited. */
export async function publishPolicyVersion(ctx: AppContext, raw: unknown): Promise<{ id: string }> {
  requireStaff(ctx, 'admin');
  const input = parseInput(publishPolicyInput, raw);
  try {
    return await withTransaction(ctx.pool, async (tx) => {
      const r = await one<{ id: string }>(tx, `INSERT INTO policy_versions (kind, version, title, body, effective_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
        input.kind,
        input.version,
        input.title,
        input.body,
        ctx.now(),
      ]);
      await recordAudit(tx, ctx, { action: 'policy.published', targetKind: 'policy', targetId: r.id, reason: input.reason, data: { kind: input.kind, version: input.version } });
      return { id: r.id };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DomainError('CONFLICT', 'That version label already exists for this policy.');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Staff access (admin)
// ---------------------------------------------------------------------------

export interface StaffMember {
  userId: string;
  name: string;
  email: string | null;
  roles: StaffRoleName[];
  mfaEnrolled: boolean;
}

export async function listStaff(ctx: AppContext): Promise<StaffMember[]> {
  requireStaff(ctx, 'admin');
  const rows = await many<{ user_id: string; display_name: string; email: string | null; roles: StaffRoleName[]; mfa: boolean }>(
    ctx.pool,
    `SELECT u.id AS user_id, u.display_name, u.email, array_agg(g.role ORDER BY g.role) AS roles, (u.mfa_enabled_at IS NOT NULL) AS mfa
       FROM role_grants g JOIN users u ON u.id = g.user_id WHERE g.revoked_at IS NULL
      GROUP BY u.id ORDER BY u.display_name`,
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.display_name, email: r.email, roles: r.roles, mfaEnrolled: r.mfa }));
}

/** Grants a staff role to an existing account (never to yourself). The new staff member must set up MFA. Audited. */
export async function grantRole(ctx: AppContext, raw: unknown): Promise<{ userId: string; role: StaffRoleName }> {
  const admin = requireStaff(ctx, 'admin');
  const input = parseInput(grantRoleInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const u = await maybeOne<{ id: string; status: string }>(tx, 'SELECT id, status FROM users WHERE lower(email) = $1', [input.email]);
    if (!u) throw new DomainError('NOT_FOUND', 'No account with that email. Ask them to sign up first.');
    if (u.id === admin.userId) throw new DomainError('FORBIDDEN', 'You can’t change your own staff roles.');
    if (u.status !== 'active') throw new DomainError('INVALID_STATE', 'That account isn’t active.');
    const r = await tx.query(`INSERT INTO role_grants (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [u.id, input.role, admin.userId]);
    if (!r.rowCount) throw new DomainError('CONFLICT', 'They already have that role.');
    await recordAudit(tx, ctx, { action: 'staff.role_granted', targetKind: 'user', targetId: u.id, reason: input.reason, data: { role: input.role } });
    return { userId: u.id, role: input.role };
  });
}

/** Revokes a staff role. You can't change your own roles, and the last admin can't be removed. Audited. */
export async function revokeRole(ctx: AppContext, raw: unknown): Promise<{ userId: string; role: StaffRoleName }> {
  const admin = requireStaff(ctx, 'admin');
  const input = parseInput(revokeRoleInput, raw);
  if (input.userId === admin.userId) throw new DomainError('FORBIDDEN', 'You can’t change your own staff roles.');
  return withTransaction(ctx.pool, async (tx) => {
    // Serialise role changes so two admins can't remove each other at once.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('role_grants'))`);
    if (input.role === 'admin') {
      const admins = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM role_grants WHERE role = 'admin' AND revoked_at IS NULL`);
      if (admins.n <= 1) throw new DomainError('INVALID_STATE', 'There must always be at least one admin.');
    }
    const r = await tx.query(`UPDATE role_grants SET revoked_at = now(), revoked_by = $3 WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL`, [input.userId, input.role, admin.userId]);
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'They don’t have that role.');
    await recordAudit(tx, ctx, { action: 'staff.role_revoked', targetKind: 'user', targetId: input.userId, reason: input.reason, data: { role: input.role } });
    return { userId: input.userId, role: input.role };
  });
}
