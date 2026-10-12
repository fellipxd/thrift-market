import { z } from 'zod';
import { DomainError } from '@thrift/domain';
import { maybeOne, one, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireStaff, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { assertWithinRateLimit, recordRateLimitHit } from '../core/rate-limit';
import { parseInput } from '../core/validation';
import { decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUrl, verifyTotp } from './totp';

const MFA_FAILURE_LIMIT = 5;
const MFA_FAILURE_WINDOW_SECONDS = 900;
const wrongCodes = new WeakSet<Error>();

function wrongCode(message: string, field: string): DomainError {
  const err = new DomainError('VALIDATION_FAILED', message, { fieldErrors: { code: field } });
  wrongCodes.add(err);
  return err;
}

/**
 * Wrong codes count against a per-account limit (5 per 15 minutes); successful checks and replays of a genuine
 * code don't, so staff aren't locked out by normal use. Failures are recorded outside the rolled-back transaction.
 */
async function guardCodeAttempt<T>(ctx: AppContext, userId: string, run: () => Promise<T>): Promise<T> {
  const bucket = `mfa-fail:${userId}`;
  await assertWithinRateLimit(ctx.pool, bucket, MFA_FAILURE_LIMIT, MFA_FAILURE_WINDOW_SECONDS, 'Too many wrong codes. Wait 15 minutes and try again.');
  try {
    return await run();
  } catch (err) {
    if (err instanceof Error && wrongCodes.has(err)) await recordRateLimitHit(ctx.pool, bucket, MFA_FAILURE_WINDOW_SECONDS);
    throw err;
  }
}

const codeInput = z.object({ code: z.string({ message: 'Enter the 6-digit code.' }).trim().min(6, 'Enter the 6-digit code.').max(20) });

export interface MfaStatus {
  enrolled: boolean;
  sessionVerified: boolean;
  recoveryCodesLeft: number;
  required: boolean;
}

export async function mfaStatus(ctx: AppContext): Promise<MfaStatus> {
  const user = requireUser(ctx);
  const r = await one<{ enabled: boolean; left: number }>(
    ctx.pool,
    `SELECT (u.mfa_enabled_at IS NOT NULL) AS enabled,
            (SELECT count(*) FROM mfa_recovery_codes c WHERE c.user_id = u.id AND c.used_at IS NULL)::int AS left
       FROM users u WHERE u.id = $1`,
    [user.userId],
  );
  return { enrolled: r.enabled, sessionVerified: user.mfaVerified, recoveryCodesLeft: r.left, required: user.roles.length > 0 };
}

/**
 * Starts enrolment: the secret to add to an authenticator app. While unconfirmed, the same pending secret is shown
 * again (so a page refresh doesn't invalidate a scanned code) unless `restart` asks for a new one.
 */
export async function startMfaEnrolment(ctx: AppContext, opts: { restart?: boolean } = {}): Promise<{ secret: string; otpauthUrl: string }> {
  const user = requireUser(ctx);
  const u = await one<{ email: string | null; phone: string | null; mfa_enabled_at: Date | null; mfa_secret: string | null }>(
    ctx.pool,
    'SELECT email, phone, mfa_enabled_at, mfa_secret FROM users WHERE id = $1',
    [user.userId],
  );
  if (u.mfa_enabled_at) throw new DomainError('INVALID_STATE', 'Two-step verification is already set up.');
  if (u.mfa_secret && !opts.restart) {
    const pending = decryptSecret(ctx.config.appSecret, u.mfa_secret);
    return { secret: pending, otpauthUrl: otpauthUrl(pending, u.email ?? u.phone ?? user.displayName) };
  }
  const secret = generateTotpSecret();
  await ctx.pool.query(`UPDATE users SET mfa_secret = $2, mfa_last_step = NULL, updated_at = now() WHERE id = $1`, [user.userId, encryptSecret(ctx.config.appSecret, secret)]);
  return { secret, otpauthUrl: otpauthUrl(secret, u.email ?? u.phone ?? user.displayName) };
}

/** Confirms enrolment with a first code; returns one-time recovery codes and verifies the current session. */
export async function confirmMfaEnrolment(ctx: AppContext, raw: unknown): Promise<{ recoveryCodes: string[] }> {
  const user = requireUser(ctx);
  const input = parseInput(codeInput, raw);
  return guardCodeAttempt(ctx, user.userId, () => withTransaction(ctx.pool, async (tx) => {
    const u = await one<{ mfa_secret: string | null; mfa_enabled_at: Date | null }>(tx, 'SELECT mfa_secret, mfa_enabled_at FROM users WHERE id = $1 FOR UPDATE', [user.userId]);
    if (u.mfa_enabled_at) throw new DomainError('INVALID_STATE', 'Two-step verification is already set up.');
    if (!u.mfa_secret) throw new DomainError('INVALID_STATE', 'Start setting up two-step verification first.');
    const step = verifyTotp(decryptSecret(ctx.config.appSecret, u.mfa_secret), input.code, ctx.now());
    if (step === null) throw wrongCode('That code didn’t match. Check your authenticator app and try again.', 'Code didn’t match.');
    const codes = generateRecoveryCodes();
    await tx.query(`UPDATE users SET mfa_enabled_at = $2, mfa_last_step = $3, updated_at = now() WHERE id = $1`, [user.userId, ctx.now(), step]);
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [user.userId]);
    for (const c of codes) await tx.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [user.userId, hashRecoveryCode(ctx.config.appSecret, c)]);
    if (user.sessionId) await tx.query('UPDATE sessions SET mfa_verified_at = $2 WHERE id = $1', [user.sessionId, ctx.now()]);
    await recordAudit(tx, ctx, { action: 'mfa.enrolled', targetKind: 'user', targetId: user.userId });
    return { recoveryCodes: codes };
  }));
}

/**
 * Verifies the current session with a TOTP code (each time step accepted once — replays are rejected) or an unused
 * recovery code (single use).
 */
export async function verifyMfa(ctx: AppContext, raw: unknown): Promise<{ verified: true; usedRecoveryCode: boolean }> {
  const user = requireUser(ctx);
  const input = parseInput(codeInput, raw);
  return guardCodeAttempt(ctx, user.userId, () => withTransaction(ctx.pool, async (tx) => {
    const u = await one<{ mfa_secret: string | null; mfa_enabled_at: Date | null; mfa_last_step: number | null }>(
      tx,
      'SELECT mfa_secret, mfa_enabled_at, mfa_last_step FROM users WHERE id = $1 FOR UPDATE',
      [user.userId],
    );
    if (!u.mfa_enabled_at || !u.mfa_secret) throw new DomainError('INVALID_STATE', 'Set up two-step verification first.');
    let usedRecoveryCode = false;
    const code = input.code.replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(decryptSecret(ctx.config.appSecret, u.mfa_secret), code, ctx.now());
      if (step === null) throw wrongCode('That code didn’t match. Check your authenticator app and try again.', 'Code didn’t match.');
      if (u.mfa_last_step !== null && step <= Number(u.mfa_last_step)) {
        throw new DomainError('VALIDATION_FAILED', 'That code was already used. Wait for the next code in your app.', { fieldErrors: { code: 'Wait for the next code.' } });
      }
      await tx.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1', [user.userId, step]);
    } else {
      const used = await maybeOne<{ id: string }>(
        tx,
        `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
        [user.userId, hashRecoveryCode(ctx.config.appSecret, code)],
      );
      if (!used) throw wrongCode('That recovery code isn’t valid or was already used.', 'Invalid recovery code.');
      usedRecoveryCode = true;
      await recordAudit(tx, ctx, { action: 'mfa.recovery_code_used', targetKind: 'user', targetId: user.userId });
    }
    if (user.sessionId) await tx.query('UPDATE sessions SET mfa_verified_at = $2 WHERE id = $1', [user.sessionId, ctx.now()]);
    return { verified: true as const, usedRecoveryCode };
  }));
}

/** Admin resets another staff member's second factor (lost device). They must enrol again; sessions are revoked. */
export async function resetUserMfa(ctx: AppContext, raw: unknown): Promise<{ userId: string }> {
  const admin = requireStaff(ctx, 'admin');
  const input = parseInput(z.object({ userId: z.string().uuid(), reason: z.string().trim().min(10, 'Give a reason (at least 10 characters).').max(500) }), raw);
  if (input.userId === admin.userId) throw new DomainError('FORBIDDEN', 'Ask another admin to reset your own two-step verification.');
  return withTransaction(ctx.pool, async (tx) => {
    const r = await tx.query(`UPDATE users SET mfa_secret = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, updated_at = now() WHERE id = $1`, [input.userId]);
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'User not found.');
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [input.userId]);
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [input.userId]);
    await recordAudit(tx, ctx, { action: 'mfa.reset', targetKind: 'user', targetId: input.userId, reason: input.reason });
    return { userId: input.userId };
  });
}
