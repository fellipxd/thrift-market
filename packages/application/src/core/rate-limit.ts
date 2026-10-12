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

/**
 * Throws RATE_LIMITED when the bucket already holds `limit` hits in the current window. Pair with
 * recordRateLimitHit to count only some outcomes (e.g. wrong codes, not successful sign-ins).
 */
export async function assertWithinRateLimit(
  db: Queryable,
  bucket: string,
  limit: number,
  windowSeconds: number,
  message = 'Too many attempts. Please wait a moment and try again.',
): Promise<void> {
  const row = await one<{ count: number }>(
    db,
    `SELECT coalesce(max(count), 0)::int AS count FROM rate_limit_counters
      WHERE bucket = $1 AND window_start = to_timestamp(floor(extract(epoch from now()) / $2) * $2)`,
    [bucket, windowSeconds],
  );
  if (row.count >= limit) throw new DomainError('RATE_LIMITED', message, { retryAfterSeconds: windowSeconds });
}

/** Counts one hit in the bucket's current window (see assertWithinRateLimit). */
export async function recordRateLimitHit(db: Queryable, bucket: string, windowSeconds: number): Promise<void> {
  await db.query(
    `INSERT INTO rate_limit_counters (bucket, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limit_counters.count + 1`,
    [bucket, windowSeconds],
  );
}
