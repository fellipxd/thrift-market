import { services } from '@/server/services';

/** Liveness + database readiness. Does not expose internals. */
export async function GET() {
  try {
    await services().pool.query('SELECT 1');
    return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ status: 'degraded' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
