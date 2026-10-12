import { NextResponse, type NextRequest } from 'next/server';
import { ingestCourierWebhook } from '@thrift/application';
import { isDomainError } from '@thrift/domain';
import { services } from '@/server/services';

export const dynamic = 'force-dynamic';

/** Courier milestone webhook: raw body is signature-checked, events are applied idempotently and only forward. */
export async function POST(req: NextRequest): Promise<Response> {
  const svc = services();
  const ctx = svc.context({ kind: 'system', name: 'webhook:courier' }, { ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null });
  const raw = await req.text();
  try {
    const res = await ingestCourierWebhook(ctx, raw, req.headers);
    if (!res.accepted) return NextResponse.json({ ok: false }, { status: 401 });
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    if (isDomainError(err)) return NextResponse.json({ ok: false, code: err.code }, { status: 400 });
    console.error('[webhook:courier] failed', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
