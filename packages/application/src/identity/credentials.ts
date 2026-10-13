import { createHash, randomInt } from 'node:crypto';
import { changePasswordInput, passwordResetInput, passwordResetRequestInput, sessionIdInput } from '@thrift/contracts';
import { DomainError } from '@thrift/domain';
import { many, maybeOne, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { assertWithinRateLimit, enforceRateLimit, recordRateLimitHit } from '../core/rate-limit';
import { parseInput } from '../core/validation';
import { notifyUser } from '../notifications/notify';
import { hashPassword, verifyPassword } from './passwords';

const RESET_TTL_MINUTES = 15;
const MAX_RESET_ATTEMPTS = 5;

const hashResetCode = (userId: string, code: string) => createHash('sha256').update(`reset:${userId}:${code}`).digest('hex');

async function findUserByContact(db: Queryable, contact: string): Promise<{ id: string; email: string | null; phone: string | null; status: string } | null> {
  const c = contact.trim();
  const phone = c.replace(/[\s()-]/g, '').replace(/^0/, '+234').replace(/^234/, '+234');
  return maybeOne(db, `SELECT id, email, phone, status FROM users WHERE (email IS NOT NULL AND lower(email) = lower($1)) OR phone = $2`, [c, phone]);
}

/**
 * Starts a password reset. The answer is the same whether or not an account exists (no account discovery); a code
 * is sent to the account's own email/phone only. Limited per contact and per network address.
 */
export async function requestPasswordReset(ctx: AppContext, raw: unknown): Promise<{ sent: true }> {
  const input = parseInput(passwordResetRequestInput, raw);
  await enforceRateLimit(ctx.pool, `reset-request-ip:${ctx.ip ?? 'unknown'}`, 20, 3600, 'Too many reset requests. Try again later.');
  await enforceRateLimit(ctx.pool, `reset-request:${input.contact.toLowerCase()}`, 5, 3600, 'Too many reset requests for this account. Try again later.');
  const user = await findUserByContact(ctx.pool, input.contact);
  if (!user || user.status !== 'active') return { sent: true };
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const byEmail = !!user.email && input.contact.includes('@');
  await withTransaction(ctx.pool, async (tx) => {
    await tx.query('UPDATE password_resets SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [user.id]);
    await tx.query('INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1, $2, $3)', [
      user.id,
      hashResetCode(user.id, code),
      new Date(ctx.now().getTime() + RESET_TTL_MINUTES * 60_000),
    ]);
    await tx.query(
      `INSERT INTO outbound_messages (user_id, channel, destination, subject, body, kind, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, 'password_reset', $6)`,
      [
        user.id,
        byEmail || !user.phone ? 'email' : 'sms',
        byEmail || !user.phone ? user.email : user.phone,
        byEmail || !user.phone ? 'Reset your password' : null,
        `Your thrift marketplace password reset code is ${code}. It expires in ${RESET_TTL_MINUTES} minutes. If you didn’t ask for it, ignore this message — your password stays the same.`,
        `reset:${user.id}:${ctx.now().getTime()}`,
      ],
    );
    await recordAudit(tx, ctx, { action: 'account.password_reset_requested', targetKind: 'user', targetId: user.id });
  });
  return { sent: true };
}

/** Completes a reset with the emailed/texted code. Signs the account out everywhere and tells the owner. */
export async function resetPassword(ctx: AppContext, raw: unknown): Promise<{ reset: true }> {
  const input = parseInput(passwordResetInput, raw);
  const bucket = `reset-code:${input.contact.toLowerCase()}`;
  await assertWithinRateLimit(ctx.pool, bucket, 10, 3600, 'Too many attempts. Request a new code later.');
  const generic = new DomainError('VALIDATION_FAILED', 'That code is not correct or has expired. Request a new one if needed.', { fieldErrors: { code: 'Incorrect or expired code' } });
  const user = await findUserByContact(ctx.pool, input.contact);
  if (!user || user.status !== 'active') {
    await recordRateLimitHit(ctx.pool, bucket, 3600);
    throw generic;
  }
  const passwordHash = await hashPassword(input.password);
  const outcome = await withTransaction(ctx.pool, async (tx) => {
    const r = await maybeOne<{ id: string; code_hash: string; attempts: number; expires_at: Date }>(
      tx,
      `SELECT id, code_hash, attempts, expires_at FROM password_resets WHERE user_id = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id],
    );
    if (!r || new Date(r.expires_at) <= ctx.now() || r.attempts >= MAX_RESET_ATTEMPTS) return 'invalid' as const;
    if (r.code_hash !== hashResetCode(user.id, input.code)) {
      await tx.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [r.id]);
      return 'invalid' as const;
    }
    await tx.query('UPDATE password_resets SET consumed_at = now() WHERE id = $1', [r.id]);
    await tx.query('UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [user.id, passwordHash]);
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    await recordAudit(tx, ctx, { action: 'account.password_reset', targetKind: 'user', targetId: user.id });
    await notifyUser(tx, {
      userId: user.id,
      topic: 'transactional',
      kind: 'password_changed',
      title: 'Your password was reset',
      body: 'You were signed out on every device. If this wasn’t you, contact support straight away.',
      link: '/account/security',
      dedupeKey: `password-reset:${r.id}`,
    });
    return 'ok' as const;
  });
  if (outcome !== 'ok') {
    await recordRateLimitHit(ctx.pool, bucket, 3600);
    throw generic;
  }
  return { reset: true };
}

/** Signed-in password change: needs the current password; every other device is signed out. */
export async function changePassword(ctx: AppContext, raw: unknown): Promise<{ changed: true; otherSessionsSignedOut: number }> {
  const actor = requireUser(ctx);
  const input = parseInput(changePasswordInput, raw);
  const bucket = `password-change:${actor.userId}`;
  await assertWithinRateLimit(ctx.pool, bucket, 5, 900, 'Too many attempts. Try again in 15 minutes.');
  const row = await maybeOne<{ password_hash: string }>(ctx.pool, 'SELECT password_hash FROM users WHERE id = $1', [actor.userId]);
  if (!row || !(await verifyPassword(input.currentPassword, row.password_hash))) {
    await recordRateLimitHit(ctx.pool, bucket, 900);
    throw new DomainError('VALIDATION_FAILED', 'Your current password is not correct.', { fieldErrors: { currentPassword: 'Not correct' } });
  }
  const passwordHash = await hashPassword(input.newPassword);
  return withTransaction(ctx.pool, async (tx) => {
    await tx.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [actor.userId, passwordHash]);
    const res = await tx.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2::uuid`,
      [actor.userId, actor.sessionId],
    );
    await recordAudit(tx, ctx, { action: 'account.password_changed', targetKind: 'user', targetId: actor.userId });
    await notifyUser(tx, {
      userId: actor.userId,
      topic: 'transactional',
      kind: 'password_changed',
      title: 'Your password was changed',
      body: 'Other devices were signed out. If this wasn’t you, reset your password and contact support.',
      link: '/account/security',
      dedupeKey: `password-changed:${actor.userId}:${ctx.now().getTime()}`,
    });
    return { changed: true as const, otherSessionsSignedOut: res.rowCount ?? 0 };
  });
}

export interface SessionView {
  id: string;
  current: boolean;
  device: string;
  createdAt: string;
  lastSeenAt: string;
}

/** Readable device label from a user agent (no fingerprinting; just what the browser says). */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'device';
  return `${browser} on ${os}`;
}

export async function listMySessions(ctx: AppContext): Promise<SessionView[]> {
  const actor = requireUser(ctx);
  const rows = await many<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date }>(
    ctx.pool,
    `SELECT id, user_agent, created_at, last_seen_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY last_seen_at DESC LIMIT 50`,
    [actor.userId, ctx.now()],
  );
  return rows.map((r) => ({
    id: r.id,
    current: r.id === actor.sessionId,
    device: deviceLabel(r.user_agent),
    createdAt: new Date(r.created_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  }));
}

/** Signs out one of your own sessions (another device). Other users' sessions read as not found. */
export async function revokeMySession(ctx: AppContext, raw: unknown): Promise<{ revoked: boolean }> {
  const actor = requireUser(ctx);
  const input = parseInput(sessionIdInput, raw);
  const res = await ctx.pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [input.sessionId, actor.userId]);
  if (!res.rowCount) throw new DomainError('NOT_FOUND', 'That session was not found or has already ended.');
  await recordAudit(ctx.pool, ctx, { action: 'account.session_revoked', targetKind: 'session', targetId: input.sessionId });
  return { revoked: true };
}

export async function revokeMyOtherSessions(ctx: AppContext): Promise<{ revoked: number }> {
  const actor = requireUser(ctx);
  const res = await ctx.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2::uuid', [actor.userId, actor.sessionId]);
  await recordAudit(ctx.pool, ctx, { action: 'account.other_sessions_revoked', targetKind: 'user', targetId: actor.userId, data: { count: res.rowCount ?? 0 } });
  return { revoked: res.rowCount ?? 0 };
}

/** Development/test only: the latest reset code sent for a contact (shown with a SANDBOX label; never in production builds). */
export async function sandboxLatestResetCode(ctx: AppContext, contact: string): Promise<string | null> {
  if (ctx.config.env !== 'development' && ctx.config.env !== 'test') return null;
  const user = await findUserByContact(ctx.pool, contact);
  if (!user) return null;
  const row = await maybeOne<{ body: string }>(ctx.pool, `SELECT body FROM outbound_messages WHERE user_id = $1 AND kind = 'password_reset' ORDER BY created_at DESC LIMIT 1`, [user.id]);
  return row ? (/\b(\d{6})\b/.exec(row.body)?.[1] ?? null) : null;
}
