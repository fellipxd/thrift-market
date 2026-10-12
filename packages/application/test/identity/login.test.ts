import { afterAll, describe, expect, it } from 'vitest';
import { one } from '@thrift/database';
import { login } from '../../src';
import { closeTestServices, createUser, systemCtx, testServices } from '../support';

afterAll(closeTestServices);

const fromIp = (n: number) => ({ ...systemCtx(), ip: `198.51.100.${n}` });

describe('sign-in attempt limits', () => {
  it('successful sign-ins never throttle the account owner; wrong passwords lock the account', async () => {
    const u = await createUser();
    const email = (await one<{ email: string }>(testServices().pool, 'SELECT email FROM users WHERE id = $1', [u.id])).email;
    for (let i = 0; i < 12; i++) {
      await expect(login(fromIp(i + 1), { contact: email, password: 'correct-horse-battery' })).resolves.toMatchObject({ userId: u.id });
    }
    for (let i = 0; i < 8; i++) {
      await expect(login(fromIp(50 + i), { contact: email, password: 'wrong-password-123' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    // Locked after repeated failures, even with the right password.
    await expect(login(fromIp(90), { contact: email, password: 'correct-horse-battery' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('wrong attempts for an unknown contact are limited per contact too', async () => {
    const contact = `nobody_${Date.now()}@example.test`;
    for (let i = 0; i < 10; i++) {
      await expect(login(fromIp(100 + i), { contact, password: 'guess-guess-guess' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    await expect(login(fromIp(120), { contact, password: 'guess-guess-guess' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
