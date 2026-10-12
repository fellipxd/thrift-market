import { createHash } from 'node:crypto';
import { maybeOne, many, type Queryable } from '@thrift/database';
import type { StaffRole, UserActor } from '../core/context';
import { randomToken } from '../core/ids';

export const SESSION_COOKIE = 'tm_session';
export const SESSION_TTL_DAYS = 30;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Queryable,
  args: { userId: string; userAgent?: string | null; ip?: string | null; now: Date },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(args.now.getTime() + SESSION_TTL_DAYS * 86_400_000);
  const row = await maybeOne<{ id: string }>(
    db,
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [args.userId, hashSessionToken(token), expiresAt, args.userAgent?.slice(0, 300) ?? null, args.ip ?? null],
  );
  return { token, sessionId: row!.id, expiresAt };
}

/** Resolves a session cookie to an actor. Suspended/deleted users and expired/revoked sessions resolve to null. */
export async function resolveSession(db: Queryable, token: string | null | undefined, now: Date): Promise<UserActor | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = await maybeOne<{
    session_id: string;
    user_id: string;
    display_name: string;
    email_verified_at: Date | null;
    phone_verified_at: Date | null;
    last_seen_at: Date;
  }>(
    db,
    `SELECT s.id AS session_id, u.id AS user_id, u.display_name, u.email_verified_at, u.phone_verified_at, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'active'`,
    [hashSessionToken(token), now],
  );
  if (!row) return null;
  const roles = await many<{ role: StaffRole }>(db, 'SELECT role FROM role_grants WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
  if (now.getTime() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await db.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [row.session_id, now]);
  }
  return {
    kind: 'user',
    userId: row.user_id,
    displayName: row.display_name,
    contactVerified: Boolean(row.email_verified_at || row.phone_verified_at),
    roles: roles.map((r) => r.role),
    sessionId: row.session_id,
  };
}

export async function revokeSession(db: Queryable, token: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashSessionToken(token)]);
}

export async function revokeAllSessions(db: Queryable, userId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}
