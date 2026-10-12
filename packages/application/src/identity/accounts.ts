import { createHash, randomInt } from 'node:crypto';
import { loginInput, registerInput, verifyContactInput } from '@thrift/contracts';
import { DomainError } from '@thrift/domain';
import { isUniqueViolation, maybeOne, one, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { assertWithinRateLimit, enforceRateLimit, recordRateLimitHit } from '../core/rate-limit';
import { parseInput } from '../core/validation';
import { DUMMY_HASH, hashPassword, verifyPassword } from './passwords';
import { createSession } from './sessions';

const CODE_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;
const MAX_FAILED_LOGINS = 8;

function hashCode(userId: string, code: string): string {
  return createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

export interface SessionResult {
  userId: string;
  token: string;
  expiresAt: Date;
}

export async function register(ctx: AppContext, raw: unknown, meta: { userAgent?: string | null } = {}): Promise<SessionResult> {
  const input = parseInput(registerInput, raw);
  await enforceRateLimit(ctx.pool, `register:${ctx.ip ?? 'unknown'}`, 10, 3600);
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTransaction(ctx.pool, async (tx) => {
      const user = await one<{ id: string }>(
        tx,
        `INSERT INTO users (display_name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.displayName, input.email, input.phone, passwordHash],
      );
      // Transactional notices are always on in-app; marketing topics start opted out (explicit opt-in).
      await tx.query(
        `INSERT INTO notification_preferences (user_id, topic, channel, opted_in, consented_at, source)
         VALUES ($1, 'transactional', 'in_app', true, now(), 'signup'),
                ($1, 'messages', 'in_app', true, now(), 'signup')`,
        [user.id],
      );
      await issueVerificationCode(tx, ctx, user.id, input.email ? 'email' : 'phone', (input.email ?? input.phone)!);
      const session = await createSession(tx, { userId: user.id, userAgent: meta.userAgent, ip: ctx.ip, now: ctx.now() });
      await recordAudit(tx, { ...ctx, actor: { kind: 'user', userId: user.id, displayName: input.displayName, contactVerified: false, roles: [], sessionId: session.sessionId, mfaVerified: false } }, {
        action: 'account.registered',
        targetKind: 'user',
        targetId: user.id,
      });
      return { userId: user.id, token: session.token, expiresAt: session.expiresAt };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DomainError('CONFLICT', 'An account already uses this email or phone number. Sign in instead.', {
        fieldErrors: { contact: 'Already registered' },
      });
    }
    throw err;
  }
}

export async function login(ctx: AppContext, raw: unknown, meta: { userAgent?: string | null } = {}): Promise<SessionResult> {
  const input = parseInput(loginInput, raw);
  await enforceRateLimit(ctx.pool, `login:${ctx.ip ?? 'unknown'}`, 30, 900);
  // Per account, only wrong attempts count (guessing protection); successful sign-ins never throttle the owner.
  const contactBucket = `login-contact:${input.contact.toLowerCase()}`;
  await assertWithinRateLimit(ctx.pool, contactBucket, 10, 900);
  const contact = input.contact.trim();
  const normalisedPhone = contact.replace(/[\s()-]/g, '').replace(/^0/, '+234').replace(/^234/, '+234');
  const user = await maybeOne<{ id: string; password_hash: string; status: string; locked_until: Date | null; failed_login_count: number }>(
    ctx.pool,
    `SELECT id, password_hash, status, locked_until, failed_login_count FROM users
      WHERE (email IS NOT NULL AND lower(email) = lower($1)) OR phone = $2`,
    [contact, normalisedPhone],
  );
  const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);
  const generic = new DomainError('UNAUTHENTICATED', 'That email/phone and password do not match.');
  if (!user) {
    await recordRateLimitHit(ctx.pool, contactBucket, 900);
    throw generic;
  }
  if (user.locked_until && new Date(user.locked_until) > ctx.now()) {
    throw new DomainError('RATE_LIMITED', 'Too many failed sign-in attempts. Try again in 15 minutes.');
  }
  if (!ok) {
    await ctx.pool.query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
        WHERE id = $1`,
      [user.id, MAX_FAILED_LOGINS],
    );
    await recordRateLimitHit(ctx.pool, contactBucket, 900);
    throw generic;
  }
  if (user.status !== 'active') throw new DomainError('FORBIDDEN', 'This account is not active. Contact support.');
  await ctx.pool.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  const session = await createSession(ctx.pool, { userId: user.id, userAgent: meta.userAgent, ip: ctx.ip, now: ctx.now() });
  return { userId: user.id, token: session.token, expiresAt: session.expiresAt };
}

async function issueVerificationCode(
  tx: import('@thrift/database').Queryable,
  ctx: AppContext,
  userId: string,
  channel: 'email' | 'phone',
  destination: string,
): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await tx.query(`UPDATE contact_verifications SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);
  await tx.query(
    `INSERT INTO contact_verifications (user_id, channel, destination, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, channel, destination, hashCode(userId, code), new Date(ctx.now().getTime() + CODE_TTL_MINUTES * 60_000)],
  );
  const id = `${userId}:${Date.now()}`;
  await tx.query(
    `INSERT INTO outbound_messages (user_id, channel, destination, subject, body, kind, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, 'verification_code', $6)`,
    [
      userId,
      channel === 'email' ? 'email' : 'sms',
      destination,
      channel === 'email' ? 'Your verification code' : null,
      `Your thrift marketplace verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`,
      `verify:${id}`,
    ],
  );
}

export async function resendVerificationCode(ctx: AppContext): Promise<void> {
  const actor = requireUser(ctx);
  await enforceRateLimit(ctx.pool, `verify-resend:${actor.userId}`, 5, 3600);
  const user = await one<{ email: string | null; phone: string | null; email_verified_at: Date | null; phone_verified_at: Date | null }>(
    ctx.pool,
    'SELECT email, phone, email_verified_at, phone_verified_at FROM users WHERE id = $1',
    [actor.userId],
  );
  if (user.email_verified_at || user.phone_verified_at) return;
  await withTransaction(ctx.pool, (tx) =>
    issueVerificationCode(tx, ctx, actor.userId, user.email ? 'email' : 'phone', (user.email ?? user.phone)!),
  );
}

export async function verifyContact(ctx: AppContext, raw: unknown): Promise<void> {
  const actor = requireUser(ctx);
  const input = parseInput(verifyContactInput, raw);
  await enforceRateLimit(ctx.pool, `verify:${actor.userId}`, 10, 900);
  await withTransaction(ctx.pool, async (tx) => {
    const v = await maybeOne<{ id: string; channel: 'email' | 'phone'; code_hash: string; attempts: number; expires_at: Date }>(
      tx,
      `SELECT id, channel, code_hash, attempts, expires_at FROM contact_verifications
        WHERE user_id = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [actor.userId],
    );
    if (!v) throw new DomainError('EXPIRED', 'Request a new code.');
    if (new Date(v.expires_at) <= ctx.now() || v.attempts >= MAX_CODE_ATTEMPTS) {
      throw new DomainError('EXPIRED', 'This code has expired. Request a new one.');
    }
    if (v.code_hash !== hashCode(actor.userId, input.code)) {
      await tx.query('UPDATE contact_verifications SET attempts = attempts + 1 WHERE id = $1', [v.id]);
      throw new DomainError('VALIDATION_FAILED', 'That code is not correct.', { fieldErrors: { code: 'Incorrect code' } });
    }
    await tx.query('UPDATE contact_verifications SET consumed_at = now() WHERE id = $1', [v.id]);
    await tx.query(
      v.channel === 'email' ? 'UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1' : 'UPDATE users SET phone_verified_at = now(), updated_at = now() WHERE id = $1',
      [actor.userId],
    );
    await recordAudit(tx, ctx, { action: 'account.contact_verified', targetKind: 'user', targetId: actor.userId, data: { channel: v.channel } });
  });
}

/** Non-production helper: the latest verification message for the signed-in user (shown with a SANDBOX label). */
export async function sandboxLatestCode(ctx: AppContext): Promise<string | null> {
  if (ctx.config.env === 'production') return null;
  const actor = requireUser(ctx);
  const row = await maybeOne<{ body: string }>(
    ctx.pool,
    `SELECT body FROM outbound_messages WHERE user_id = $1 AND kind = 'verification_code' ORDER BY created_at DESC LIMIT 1`,
    [actor.userId],
  );
  return row ? (/\b(\d{6})\b/.exec(row.body)?.[1] ?? null) : null;
}

export interface AccountSummary {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  contactVerified: boolean;
  createdAt: Date;
}

export async function getAccount(ctx: AppContext): Promise<AccountSummary> {
  const actor = requireUser(ctx);
  const u = await one<{ id: string; display_name: string; email: string | null; phone: string | null; email_verified_at: Date | null; phone_verified_at: Date | null; created_at: Date }>(
    ctx.pool,
    'SELECT id, display_name, email, phone, email_verified_at, phone_verified_at, created_at FROM users WHERE id = $1',
    [actor.userId],
  );
  return {
    id: u.id,
    displayName: u.display_name,
    email: u.email,
    phone: u.phone,
    contactVerified: Boolean(u.email_verified_at || u.phone_verified_at),
    createdAt: u.created_at,
  };
}
