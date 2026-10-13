import { afterAll, describe, expect, it } from 'vitest';
import { one } from '@thrift/database';
import {
  changePassword,
  createSession,
  listMySessions,
  login,
  requestPasswordReset,
  resetPassword,
  resolveSession,
  revokeMyOtherSessions,
  revokeMySession,
} from '../../src';
import { closeTestServices, createUser, ctxFor, systemCtx, testServices, type TestUser } from '../support';

afterAll(closeTestServices);

let ipSeq = 1;
const fromIp = (now?: () => Date) => ({ ...systemCtx(now), ip: `203.0.113.${ipSeq++ % 250}` });
const pool = () => testServices().pool;
const emailOf = async (u: TestUser) => (await one<{ email: string }>(pool(), 'SELECT email FROM users WHERE id = $1', [u.id])).email;
const latestCode = async (userId: string) => {
  const r = await one<{ body: string }>(pool(), `SELECT body FROM outbound_messages WHERE user_id = $1 AND kind = 'password_reset' ORDER BY created_at DESC LIMIT 1`, [userId]);
  return /\b(\d{6})\b/.exec(r.body)![1]!;
};
const sessionFor = async (u: TestUser, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0') => createSession(pool(), { userId: u.id, now: new Date(), userAgent: ua });

describe('password reset (forgot password)', () => {
  it('answers the same for unknown contacts, and resets with the right code: everywhere signed out, old password dead', async () => {
    expect(await requestPasswordReset(fromIp(), { contact: 'nobody-here@example.test' })).toEqual({ sent: true });
    const u = await createUser();
    const email = await emailOf(u);
    const s1 = await sessionFor(u);
    const s2 = await sessionFor(u);
    expect(await requestPasswordReset(fromIp(), { contact: email.toUpperCase() })).toEqual({ sent: true });
    const code = await latestCode(u.id);
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(resetPassword(fromIp(), { contact: email, code: wrong, password: 'a-brand-new-password' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(resetPassword(fromIp(), { contact: 'nobody-here@example.test', code, password: 'a-brand-new-password' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await resetPassword(fromIp(), { contact: email, code, password: 'a-brand-new-password' })).toEqual({ reset: true });
    expect(await resolveSession(pool(), s1.token, new Date())).toBeNull();
    expect(await resolveSession(pool(), s2.token, new Date())).toBeNull();
    await expect(login(fromIp(), { contact: email, password: 'correct-horse-battery' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(login(fromIp(), { contact: email, password: 'a-brand-new-password' })).resolves.toMatchObject({ userId: u.id });
    // A code works once.
    await expect(resetPassword(fromIp(), { contact: email, code, password: 'yet-another-password' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const notice = await one<{ n: number }>(pool(), `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'password_changed'`, [u.id]);
    expect(notice.n).toBe(1);
  });

  it('codes expire, and five wrong guesses burn the code', async () => {
    const u = await createUser();
    const email = await emailOf(u);
    await requestPasswordReset(fromIp(), { contact: email });
    const code = await latestCode(u.id);
    const later = () => new Date(Date.now() + 20 * 60_000);
    await expect(resetPassword(fromIp(later), { contact: email, code, password: 'a-brand-new-password' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await requestPasswordReset(fromIp(), { contact: email });
    const fresh = await latestCode(u.id);
    const wrong = fresh === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i++) await expect(resetPassword(fromIp(), { contact: email, code: wrong, password: 'a-brand-new-password' })).rejects.toBeTruthy();
    await expect(resetPassword(fromIp(), { contact: email, code: fresh, password: 'a-brand-new-password' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('password change and signed-in devices', () => {
  it('needs the current password and signs out every other device, keeping this one', async () => {
    const u = await createUser();
    const current = await sessionFor(u);
    const other = await sessionFor(u, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1');
    const ctx = ctxFor({ ...u.actor, sessionId: current.sessionId });
    await expect(changePassword(ctx, { currentPassword: 'not-my-password', newPassword: 'a-brand-new-password' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await changePassword(ctx, { currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-password' })).toEqual({ changed: true, otherSessionsSignedOut: 1 });
    expect(await resolveSession(pool(), current.token, new Date())).not.toBeNull();
    expect(await resolveSession(pool(), other.token, new Date())).toBeNull();
  });

  it('lists your devices and signs one or all others out; other people’s sessions read as not found', async () => {
    const u = await createUser();
    const current = await sessionFor(u);
    const phone = await sessionFor(u, 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile');
    const tablet = await sessionFor(u, 'Mozilla/5.0 (iPad; CPU OS 17_0) Safari/604.1');
    const ctx = ctxFor({ ...u.actor, sessionId: current.sessionId });
    const list = await listMySessions(ctx);
    expect(list).toHaveLength(3);
    expect(list.find((s) => s.id === current.sessionId)!.current).toBe(true);
    expect(list.map((s) => s.device).sort()).toEqual(['Chrome on Android', 'Chrome on Windows', 'Safari on iOS']);

    const stranger = await createUser();
    await expect(revokeMySession(stranger.ctx, { sessionId: phone.sessionId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await revokeMySession(ctx, { sessionId: phone.sessionId })).toEqual({ revoked: true });
    expect(await resolveSession(pool(), phone.token, new Date())).toBeNull();
    expect(await revokeMyOtherSessions(ctx)).toEqual({ revoked: 1 });
    expect(await resolveSession(pool(), tablet.token, new Date())).toBeNull();
    expect(await resolveSession(pool(), current.token, new Date())).not.toBeNull();
  });
});
