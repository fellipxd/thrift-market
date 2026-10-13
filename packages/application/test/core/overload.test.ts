import { afterAll, describe, expect, it } from 'vitest';
import { createPool, isOverloadError } from '@thrift/database';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://thrift:thrift@localhost:5432/thrift_test';
const pools: ReturnType<typeof createPool>[] = [];
afterAll(async () => {
  for (const p of pools) await p.end();
});

describe('R25: overload is recognised as "busy", not an internal error', () => {
  it('a full pool and a statement timeout are overload; ordinary errors are not', async () => {
    const pool = createPool({ connectionString: url, max: 1, connectionTimeoutMs: 200, statementTimeoutMs: 150 });
    pools.push(pool);
    const held = await pool.connect();
    const waited = await pool.query('SELECT 1').catch((e) => e);
    expect(isOverloadError(waited)).toBe(true);
    held.release();
    const slow = await pool.query('SELECT pg_sleep(1)').catch((e) => e);
    expect(isOverloadError(slow)).toBe(true);
    const syntax = await pool.query('SELEC 1').catch((e) => e);
    expect(isOverloadError(syntax)).toBe(false);
    expect(isOverloadError(new Error('boom'))).toBe(false);
    expect(isOverloadError(null)).toBe(false);
  });
});
