import { createHash } from 'node:crypto';
import { DomainError } from '@thrift/domain';
import { isUniqueViolation, maybeOne, type Pool } from '@thrift/database';

/**
 * Request-level idempotency for client-retried commands (checkout start, bids, offers).
 * The first call stores its JSON result; retries with the same key and body return it.
 * The same key with a different body is a conflict.
 */
export async function withIdempotency<T>(
  pool: Pool,
  args: { scope: string; actorId: string; key: string | null | undefined; request: unknown },
  fn: () => Promise<T>,
): Promise<T> {
  if (!args.key) return fn();
  const requestHash = createHash('sha256').update(JSON.stringify(args.request ?? null)).digest('hex');
  const existing = await maybeOne<{ request_hash: string; response: T | null }>(
    pool,
    'SELECT request_hash, response FROM idempotency_records WHERE scope = $1 AND actor_id = $2 AND key = $3',
    [args.scope, args.actorId, args.key],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) throw new DomainError('CONFLICT', 'This request key was already used for a different request.');
    if (existing.response !== null) return existing.response;
    throw new DomainError('CONFLICT', 'This request is already being processed. Check its status before retrying.');
  }
  try {
    await pool.query('INSERT INTO idempotency_records (scope, actor_id, key, request_hash) VALUES ($1, $2, $3, $4)', [
      args.scope,
      args.actorId,
      args.key,
      requestHash,
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError('CONFLICT', 'This request is already being processed.');
    throw err;
  }
  try {
    const result = await fn();
    await pool.query('UPDATE idempotency_records SET response = $4 WHERE scope = $1 AND actor_id = $2 AND key = $3', [
      args.scope,
      args.actorId,
      args.key,
      JSON.stringify(result ?? null),
    ]);
    return result;
  } catch (err) {
    // Business failures are not cached; the client may retry with the same key after fixing the cause.
    await pool.query('DELETE FROM idempotency_records WHERE scope = $1 AND actor_id = $2 AND key = $3', [args.scope, args.actorId, args.key]);
    throw err;
  }
}
