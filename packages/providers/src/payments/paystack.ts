import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  InitializePaymentInput,
  InitializePaymentResult,
  NormalizedPaymentEvent,
  PaymentProvider,
  RefundInput,
  RefundResult,
  TransferInput,
  TransferResult,
  VerifyPaymentResult,
} from './types';
import { headerValue } from './types';

/**
 * Paystack adapter written against Paystack's public API documentation (transaction initialize/verify,
 * refunds, transfers, x-paystack-signature HMAC-SHA512 webhooks).
 *
 * NOT ENABLED BY DEFAULT. Paystack splits are not escrow, and published guidance on escrow-style
 * marketplaces is inconsistent (plan S7-S12). Activating this adapter requires the owner's decision D04:
 * provider confirmation of the Nigerian collection/retention/release/refund model for this business.
 */
export class PaystackPaymentProvider implements PaymentProvider {
  readonly name = 'paystack' as const;
  readonly isSandbox: boolean;
  private readonly base = 'https://api.paystack.co';

  constructor(private readonly opts: { secretKey: string; fetchImpl?: typeof fetch }) {
    if (!opts.secretKey) throw new Error('PAYSTACK_SECRET_KEY is required for the Paystack adapter');
    this.isSandbox = opts.secretKey.startsWith('sk_test_');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.secretKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: unknown };
    if (!res.ok || json.status === false) {
      const err = new Error(`Paystack ${method} ${path} failed: ${res.status} ${json.message ?? ''}`.trim());
      (err as Error & { httpStatus?: number }).httpStatus = res.status;
      throw err;
    }
    return json.data as T;
  }

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const data = await this.call<{ authorization_url: string; reference: string }>('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amountMinor,
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    });
    return { authorizationUrl: data.authorization_url, providerReference: data.reference };
  }

  async verify(reference: string): Promise<VerifyPaymentResult> {
    try {
      const data = await this.call<{ status: string; amount: number; currency: string; id: number; paid_at: string | null }>(
        'GET',
        `/transaction/verify/${encodeURIComponent(reference)}`,
      );
      const status =
        data.status === 'success' ? 'succeeded' : data.status === 'failed' ? 'failed' : data.status === 'abandoned' ? 'abandoned' : 'pending';
      return {
        status,
        amountMinor: data.amount,
        currency: data.currency,
        providerTransactionId: String(data.id),
        paidAt: data.paid_at ? new Date(data.paid_at) : null,
        raw: data,
      };
    } catch (err) {
      if ((err as { httpStatus?: number }).httpStatus === 404) {
        return { status: 'not_found', amountMinor: null, currency: null, providerTransactionId: null, paidAt: null, raw: null };
      }
      throw err;
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const data = await this.call<{ status: string; id: number }>('POST', '/refund', {
      transaction: input.reference,
      amount: input.amountMinor,
    });
    const status = data.status === 'processed' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'processing';
    return { status, providerReference: String(data.id), raw: data };
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    const data = await this.call<{ status: string; transfer_code: string }>('POST', '/transfer', {
      source: 'balance',
      amount: input.amountMinor,
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.reason,
    });
    const status = data.status === 'success' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'processing';
    return { status, providerReference: data.transfer_code, raw: data };
  }

  verifyWebhookSignature(rawBody: string, headers: Headers | Record<string, string | undefined>): boolean {
    const given = headerValue(headers, 'x-paystack-signature');
    if (!given) return false;
    const expected = createHmac('sha512', this.opts.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(given, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): NormalizedPaymentEvent {
    const body = JSON.parse(rawBody) as { event?: string; data?: { id?: number; reference?: string; transaction_reference?: string } };
    const map: Record<string, NormalizedPaymentEvent['type']> = {
      'charge.success': 'charge.success',
      'refund.processed': 'refund.processed',
      'refund.failed': 'refund.failed',
      'transfer.success': 'transfer.success',
      'transfer.failed': 'transfer.failed',
    };
    const reference = body.data?.reference ?? body.data?.transaction_reference ?? null;
    return {
      dedupeKey: `${body.event}:${body.data?.id ?? reference}`,
      type: map[body.event ?? ''] ?? 'other',
      reference,
      raw: body,
    };
  }
}
