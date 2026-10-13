import { services } from '@/server/services';

/**
 * Liveness + readiness. 503 only when the database is unreachable (take the instance out of rotation); a stale
 * background worker reports "degraded" with 200 so web traffic keeps flowing while operators look. No internals.
 */
export async function GET() {
  const started = Date.now();
  try {
    const r = await services().pool.query<{ lag: number | null }>(
      `SELECT extract(epoch FROM (now() - max(last_run_at)))::int AS lag FROM worker_heartbeats`,
    );
    const dbMs = Date.now() - started;
    const workerLagSeconds = r.rows[0]?.lag ?? null;
    const workerOk = workerLagSeconds !== null && workerLagSeconds < 300;
    return Response.json(
      { status: workerOk ? 'ok' : 'degraded', db: 'ok', dbMs, worker: workerOk ? 'ok' : 'stale', workerLagSeconds },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return Response.json({ status: 'down', db: 'unreachable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
