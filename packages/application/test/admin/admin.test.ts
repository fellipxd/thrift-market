import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminOverview,
  confirmMfaEnrolment,
  createSession,
  grantRole,
  listSettings,
  mfaStatus,
  operationsStatus,
  publishPolicyVersion,
  replayWebhook,
  resetUserMfa,
  resolveSession,
  retryOutboxEvent,
  revokeRole,
  searchAudit,
  startMfaEnrolment,
  totp,
  updateSetting,
  verifyMfa,
  verifyTotp,
} from '../../src';
import { base32Encode, hotp } from '../../src/identity/totp';
import { clearSettingsCache } from '../../src/core/settings';
import { closeTestServices, createUser, ctxFor, testServices } from '../support';
import { ensureCheckoutReferenceData, key } from '../checkout/helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

const pool = () => testServices().pool;

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors (6-digit truncation)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(hotp(secret, 1)).toBe('287082'); // T = 59 s
    expect(totp(secret, new Date(1111111109 * 1000))).toBe('081804');
    expect(totp(secret, new Date(1234567890 * 1000))).toBe('005924');
    expect(verifyTotp(secret, '287082', new Date(59_000))).toBe(1);
    expect(verifyTotp(secret, '287082', new Date(59_000 + 30_000))).toBe(1); // one step of drift allowed
    expect(verifyTotp(secret, '287082', new Date(59_000 + 90_000))).toBeNull();
    expect(verifyTotp(secret, 'abc123', new Date(59_000))).toBeNull();
  });
});

describe('staff MFA', () => {
  async function sessionUser(roles: ('admin' | 'support')[] = []) {
    const u = await createUser({ roles });
    const s = await createSession(pool(), { userId: u.id, now: new Date() });
    const actor = (await resolveSession(pool(), s.token, new Date()))!;
    return { u, token: s.token, ctx: ctxFor(actor), at: (ms: number) => ctxFor(actor, () => new Date(ms)) };
  }

  it('enrolment, session verification, replay protection and single-use recovery codes', async () => {
    const { u, token, ctx, at } = await sessionUser(['support']);
    expect((await resolveSession(pool(), token, new Date()))!.mfaVerified).toBe(false);
    // Without MFA a staff session can't use staff tools.
    await expect(adminOverview(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN', details: { mfaRequired: true } });
    const { secret, otpauthUrl } = await startMfaEnrolment(ctx);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    const stored = (await pool().query('SELECT mfa_secret FROM users WHERE id = $1', [u.id])).rows[0].mfa_secret;
    expect(stored).not.toContain(secret);
    const t0 = Date.now();
    await expect(confirmMfaEnrolment(ctx, { code: '000000' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const { recoveryCodes } = await confirmMfaEnrolment(at(t0), { code: totp(secret, new Date(t0)) });
    expect(recoveryCodes).toHaveLength(10);
    expect((await resolveSession(pool(), token, new Date()))!.mfaVerified).toBe(true);

    // A second session must verify; the code just used for enrolment can't be replayed.
    const s2 = await createSession(pool(), { userId: u.id, now: new Date() });
    const ctx2 = ctxFor((await resolveSession(pool(), s2.token, new Date()))!, () => new Date(t0));
    await expect(verifyMfa(ctx2, { code: totp(secret, new Date(t0)) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const next = t0 + 30_000;
    const ctx2later = ctxFor((await resolveSession(pool(), s2.token, new Date()))!, () => new Date(next));
    await verifyMfa(ctx2later, { code: totp(secret, new Date(next)) });
    await expect(verifyMfa(ctx2later, { code: totp(secret, new Date(next)) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await resolveSession(pool(), s2.token, new Date()))!.mfaVerified).toBe(true);

    const s3 = await createSession(pool(), { userId: u.id, now: new Date() });
    const ctx3 = ctxFor((await resolveSession(pool(), s3.token, new Date()))!);
    expect((await verifyMfa(ctx3, { code: recoveryCodes[0]! })).usedRecoveryCode).toBe(true);
    const s4 = await createSession(pool(), { userId: u.id, now: new Date() });
    await expect(verifyMfa(ctxFor((await resolveSession(pool(), s4.token, new Date()))!), { code: recoveryCodes[0]! })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await mfaStatus(ctx3)).recoveryCodesLeft).toBe(9);
    // Verified sessions expire after the staff window.
    await pool().query(`UPDATE sessions SET mfa_verified_at = now() - interval '13 hours' WHERE id = $1`, [ctx3.actor.kind === 'user' ? ctx3.actor.sessionId : null]);
    expect((await resolveSession(pool(), s3.token, new Date()))!.mfaVerified).toBe(false);
  });

  it('only wrong codes count towards the attempt limit', async () => {
    const { ctx, at } = await sessionUser(['support']);
    const { secret } = await startMfaEnrolment(ctx);
    const t0 = Date.now();
    await confirmMfaEnrolment(at(t0), { code: totp(secret, new Date(t0)) });
    // Successful checks never lock a member out.
    for (let i = 1; i <= 6; i++) {
      const when = t0 + i * 30_000;
      await verifyMfa(at(when), { code: totp(secret, new Date(when)) });
    }
    for (let i = 0; i < 5; i++) {
      await expect(verifyMfa(ctx, { code: 'ZZZZ-ZZZZ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    const later = t0 + 7 * 30_000;
    await expect(verifyMfa(at(later), { code: totp(secret, new Date(later)) })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('an admin can reset another member’s MFA (not their own), revoking their sessions', async () => {
    const admin = await createUser({ roles: ['admin'] });
    const { u, token } = await sessionUser(['support']);
    await expect(resetUserMfa(admin.ctx, { userId: admin.id, reason: 'Lost my own phone today' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await resetUserMfa(admin.ctx, { userId: u.id, reason: 'Lost phone, identity confirmed by video call' });
    expect(await resolveSession(pool(), token, new Date())).toBeNull();
  });
});

describe('operations console', () => {
  it('settings need admin + a reason, stay within range and are audited', async () => {
    const admin = await createUser({ roles: ['admin'] });
    const support = await createUser({ roles: ['support'] });
    await expect(updateSetting(support.ctx, { key: 'checkout_hold_minutes', value: '15', reason: 'Buyers need more time to pay' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateSetting(admin.ctx, { key: 'checkout_hold_minutes', value: '15', reason: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(updateSetting(admin.ctx, { key: 'checkout_hold_minutes', value: '999', reason: 'Buyers need more time to pay' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(updateSetting(admin.ctx, { key: 'not_a_setting', value: '1', reason: 'Buyers need more time to pay' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await updateSetting(admin.ctx, { key: 'checkout_hold_minutes', value: '12', reason: 'Buyers on slow networks need more time' });
    expect((await listSettings(admin.ctx)).find((s) => s.key === 'checkout_hold_minutes')?.value).toBe(12);
    const audit = await pool().query(`SELECT data, reason FROM audit_events WHERE action = 'settings.updated' AND target_id = 'checkout_hold_minutes' ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0]).toMatchObject({ reason: 'Buyers on slow networks need more time', data: { to: 12 } });
    await updateSetting(admin.ctx, { key: 'checkout_hold_minutes', value: '10', reason: 'Back to the draft default value' });
    clearSettingsCache();
    await publishPolicyVersion(admin.ctx, { kind: 'returns', version: `v-${key()}`, title: 'Returns policy', body: 'Undisclosed defects reported within the window are refundable.', reason: 'Clarified the wording' });
  });

  it('staff roles: no self-grants, last admin protected, all changes audited', async () => {
    const admin = await createUser({ roles: ['admin'] });
    const target = await createUser();
    await expect(grantRole(admin.ctx, { email: admin.email, role: 'finance', reason: 'Granting myself finance' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await grantRole(admin.ctx, { email: target.email, role: 'finance', reason: 'Joined the finance team' });
    await expect(grantRole(admin.ctx, { email: target.email, role: 'finance', reason: 'Joined the finance team' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await revokeRole(admin.ctx, { userId: target.id, role: 'finance', reason: 'Moved to another team' });
    await expect(revokeRole(admin.ctx, { userId: admin.id, role: 'admin', reason: 'Stepping down from admin' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await pool().query(`SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action LIKE 'staff.role_%'`, [target.id])).rows[0].n).toBe(2);
    // The last admin can't be removed by anyone.
    await pool().query(`UPDATE role_grants SET revoked_at = now() WHERE role = 'admin' AND revoked_at IS NULL AND user_id <> $1`, [admin.id]);
    const other = await createUser({ roles: ['admin'] });
    await pool().query(`UPDATE role_grants SET revoked_at = now() WHERE user_id = $1`, [other.id]);
    await expect(revokeRole(other.ctx, { userId: admin.id, role: 'admin', reason: 'Removing the only admin' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('audit search hides finance-sensitive actions from non-finance staff', async () => {
    const support = await createUser({ roles: ['support'] });
    const finance = await createUser({ roles: ['finance'] });
    await pool().query(`INSERT INTO audit_events (actor_kind, action, target_kind, target_id, reason) VALUES ('staff', 'refund.approved', 'refund', $1, 'test')`, [key()]);
    await pool().query(`INSERT INTO audit_events (actor_kind, action, target_kind, target_id, reason) VALUES ('staff', 'review.hide', 'review', $1, 'test')`, [key()]);
    const s = await searchAudit(support.ctx, {});
    expect(s.entries.some((e) => e.action.startsWith('refund.'))).toBe(false);
    expect(s.entries.some((e) => e.action === 'review.hide')).toBe(true);
    const f = await searchAudit(finance.ctx, { action: 'refund' });
    expect(f.entries.length).toBeGreaterThan(0);
    expect(f.entries.every((e) => e.action.startsWith('refund'))).toBe(true);
    await expect(searchAudit((await createUser()).ctx, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('dead events and failed webhooks can be retried by an admin, with an audit trail', async () => {
    const admin = await createUser({ roles: ['admin'] });
    const support = await createUser({ roles: ['support'] });
    const ev = (await pool().query(`INSERT INTO outbox_events (topic, status, attempts, last_error, dedupe_key) VALUES ('test.topic', 'dead', 10, 'boom', $1) RETURNING id`, [key()])).rows[0].id;
    const wh = (await pool().query(`INSERT INTO webhook_inbox (provider, dedupe_key, event_type, payload, signature_valid, status, attempts) VALUES ('sandbox', $1, 'charge.success', '{}', true, 'failed', 8) RETURNING id`, [key()])).rows[0].id;
    await expect(operationsStatus(support.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ops = await operationsStatus(admin.ctx);
    expect(ops.deadEvents.map((d) => d.id)).toContain(Number(ev));
    expect(ops.failedWebhooks.map((w) => w.id)).toContain(wh);
    await retryOutboxEvent(admin.ctx, { id: String(ev), reason: 'Handler bug fixed in release 12' });
    await replayWebhook(admin.ctx, { id: wh, reason: 'Provider outage resolved, replaying' });
    expect((await pool().query('SELECT status FROM outbox_events WHERE id = $1', [ev])).rows[0].status).toBe('pending');
    expect((await pool().query('SELECT status FROM webhook_inbox WHERE id = $1', [wh])).rows[0].status).toBe('pending');
    await expect(retryOutboxEvent(admin.ctx, { id: String(ev), reason: 'Retrying a second time' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await pool().query(`UPDATE outbox_events SET status = 'done' WHERE id = $1`, [ev]);
    await pool().query(`UPDATE webhook_inbox SET status = 'ignored' WHERE id = $1`, [wh]);
    const overview = await adminOverview(support.ctx);
    expect(overview.counts.map((c) => c.key)).toContain('disputes');
  });
});
