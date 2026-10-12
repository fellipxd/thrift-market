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
 * Deterministic, clearly-labelled sandbox payment provider. No real money moves.
 * The hosted "payment page" lives in the web app at /sandbox/pay/[reference]; it records the simulated
 * outcome through SandboxPaymentStore and posts a signed webhook, mirroring a real provider's flow.
 */
export interface SandboxPaymentRecord {
  reference: string;
  amountMinor: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'abandoned';
  paidAt: Date | null;
  transactionId: string;
}

export interface SandboxPaymentStore {
  get(reference: string): Promise<SandboxPaymentRecord | null>;
  put(record: SandboxPaymentRecord): Promise<void>;
}

export class InMemorySandboxStore implements SandboxPaymentStore {
  private readonly records = new Map<string, SandboxPaymentRecord>();
  async get(reference: string) {
    return this.records.get(reference) ?? null;
  }
  async put(record: SandboxPaymentRecord) {
    this.records.set(record.reference, record);
  }
}

export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';

export function signSandboxPayload(secret: string, rawBody: string): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox' as const;
  readonly isSandbox = true;

  constructor(
    private readonly opts: { baseUrl: string; webhookSecret: string; store: SandboxPaymentStore },
  ) {}

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const existing = await this.opts.store.get(input.reference);
    if (!existing) {
      await this.opts.store.put({
        reference: input.reference,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: 'pending',
        paidAt: null,
        transactionId: `sbx_${input.reference}`,
      });
    }
    const url = new URL(`/sandbox/pay/${encodeURIComponent(input.reference)}`, this.opts.baseUrl);
    url.searchParams.set('callback', input.callbackUrl);
    return { authorizationUrl: url.toString(), providerReference: input.reference };
  }

  async verify(reference: string): Promise<VerifyPaymentResult> {
    const rec = await this.opts.store.get(reference);
    if (!rec) return { status: 'not_found', amountMinor: null, currency: null, providerTransactionId: null, paidAt: null, raw: null };
    return {
      status: rec.status,
      amountMinor: rec.amountMinor,
      currency: rec.currency,
      providerTransactionId: rec.transactionId,
      paidAt: rec.paidAt,
      raw: rec,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const rec = await this.opts.store.get(input.reference);
    if (!rec || rec.status !== 'succeeded' || input.amountMinor > rec.amountMinor) {
      return { status: 'failed', providerReference: null, raw: { error: 'not_refundable' } };
    }
    return { status: 'succeeded', providerReference: `sbx_rf_${input.idempotencyKey}`, raw: { ok: true } };
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    return { status: 'succeeded', providerReference: `sbx_tr_${input.reference}`, raw: { ok: true } };
  }

  verifyWebhookSignature(rawBody: string, headers: Headers | Record<string, string | undefined>): boolean {
    const given = headerValue(headers, SANDBOX_SIGNATURE_HEADER);
    if (!given) return false;
    const expected = signSandboxPayload(this.opts.webhookSecret, rawBody);
    const a = Buffer.from(given, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): NormalizedPaymentEvent {
    const body = JSON.parse(rawBody) as { id?: string; event?: string; data?: { reference?: string } };
    const type = (['charge.success', 'charge.failed', 'refund.processed', 'refund.failed', 'transfer.success', 'transfer.failed'] as const).find(
      (t) => t === body.event,
    );
    return {
      dedupeKey: String(body.id ?? `${body.event}:${body.data?.reference}`),
      type: type ?? 'other',
      reference: body.data?.reference ?? null,
      raw: body,
    };
  }
}
