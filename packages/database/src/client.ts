import pg from 'pg';

// int8 (bigint) -> number. Money is stored in minor units and stays far below 2^53.
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`int8 value ${value} exceeds JavaScript safe integer range`);
  }
  return n;
});
// numeric -> number (ratings, coordinates). Never used for money.
pg.types.setTypeParser(1700, (value: string) => Number(value));

export type Row = Record<string, unknown>;

/** Anything that can run a parameterised query: the pool or a transaction client. */
export interface Queryable {
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<T>>;
}

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
  /** How long a request waits for a free connection before failing as "busy" (default 5 s). */
  connectionTimeoutMs?: number;
  application_name?: string;
}

export function createPool(opts: CreatePoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: opts.application_name ?? 'thrift',
  });
  pool.on('error', (err) => {
    // Idle client errors must not crash the process; they are logged and the client is discarded.
    console.error('[db] idle client error', err.message);
  });
  return pool;
}

export async function many<T extends Row>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function maybeOne<T extends Row>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const res = await db.query<T>(text, params);
  if (res.rows.length > 1) {
    throw new Error(`Expected at most one row, got ${res.rows.length}`);
  }
  return res.rows[0] ?? null;
}

export async function one<T extends Row>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const row = await maybeOne<T>(db, text, params);
  if (!row) throw new Error('Expected exactly one row, got none');
  return row;
}

export async function exec(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const res = await db.query(text, params);
  return res.rowCount ?? 0;
}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  isolation?: IsolationLevel;
  /** Retries on serialization failure / deadlock (40001, 40P01). */
  retries?: number;
  /** Lock wait ceiling inside this transaction. Keeps hot-row contention bounded. */
  lockTimeoutMs?: number;
}

const RETRYABLE = new Set(['40001', '40P01']);

/**
 * Runs fn inside a short transaction. Never call external providers inside fn:
 * reserve/record first, call the provider after commit, then apply the result in a new transaction.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${(opts.isolation ?? 'read committed').toUpperCase()}`);
      await client.query(`SET LOCAL lock_timeout = '${Math.max(100, opts.lockTimeoutMs ?? 5000)}ms'`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** True when err is a Postgres unique-violation, optionally for a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23514' && (!constraint || e.constraint === constraint);
}

export function isLockTimeout(err: unknown): boolean {
  return (err as { code?: string })?.code === '55P03';
}

/**
 * The database is saturated rather than broken: no free pooled connection in time, too many connections, or a
 * statement/lock timeout. Callers answer "busy, try again" (HTTP 503 + Retry-After) instead of an internal error.
 */
export function isOverloadError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === '53300' || e.code === '57014' || e.code === '55P03') return true;
  return /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(e.message ?? '');
}
