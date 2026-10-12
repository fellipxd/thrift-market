import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ingestPaymentWebhook, processWebhookRow } from '@thrift/application';
import { isDomainError } from '@thrift/domain';
import { services } from './services';

/**
 * Payment provider webhook endpoint. Reads the raw body (the signature covers the exact bytes), authenticates
 * and stores it, then acknowledges. Processing runs inline as a fast path; the worker retries anything left.
 * Never trusts the payload: processing re-verifies the transaction with the provider.
 */
export function paymentWebhookHandler(provider: 'sandbox' | 'paystack') {
  return async (req: NextRequest): Promise<Response> => {
    const svc = services();
    const ctx = svc.context({ kind: 'system', name: `webhook:${provider}` }, { ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null });
    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    try {
      const res = await ingestPaymentWebhook(ctx, provider, raw, req.headers);
      if (!res.accepted) return NextResponse.json({ ok: false }, { status: 401 });
      if (res.inboxId) {
        try {
          await processWebhookRow(ctx, res.inboxId);
        } catch (err) {
          // Stored durably; the worker will retry.
          console.error(`[webhook:${provider}] inline processing failed inbox=${res.inboxId}`, err);
        }
      }
      return NextResponse.json({ ok: true, duplicate: res.duplicate });
    } catch (err) {
      if (isDomainError(err)) {
        return NextResponse.json({ ok: false, code: err.code }, { status: err.code === 'NOT_FOUND' ? 404 : 400 });
      }
      console.error(`[webhook:${provider}] ingest failed`, err);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
  };
}
