import { DomainError } from '@thrift/domain';
import { one, type Queryable } from '@thrift/database';

/**
 * Fixed-window counter in Postgres (no Redis dependency at launch scale; see ADR-0004).
 * Throws RATE_LIMITED when the bucket exceeds `limit` within `windowSeconds`.
 */
export async function enforceRateLimit(
  db: Queryable,
  bucket: string,
  limit: number,
  windowSeconds: number,
  message = 'Too many attempts. Please wait a moment and try again.',
): Promise<void> {
  const row = await one<{ count: number }>(
    db,
    `INSERT INTO rate_limit_counters (bucket, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limit_counters.count + 1
     RETURNING count`,
    [bucket, windowSeconds],
  );
  if (row.count > limit) throw new DomainError('RATE_LIMITED', message, { retryAfterSeconds: windowSeconds });
}
