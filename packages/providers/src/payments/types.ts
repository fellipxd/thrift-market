export type ProviderPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'abandoned' | 'not_found';

export interface InitializePaymentInput {
  reference: string;
  amountMinor: number;
  currency: 'NGN';
  email: string;
  callbackUrl: string;
  metadata: Record<string, string>;
}

export interface InitializePaymentResult {
  authorizationUrl: string;
  providerReference: string;
}

export interface VerifyPaymentResult {
  status: ProviderPaymentStatus;
  amountMinor: number | null;
  currency: string | null;
  providerTransactionId: string | null;
  paidAt: Date | null;
  raw: unknown;
}

export interface RefundInput {
  reference: string;
  amountMinor: number;
  idempotencyKey: string;
}

export interface RefundResult {
  status: 'processing' | 'succeeded' | 'failed';
  providerReference: string | null;
  raw: unknown;
}

export interface TransferInput {
  recipientCode: string;
  amountMinor: number;
  reference: string;
  reason: string;
}

export interface TransferResult {
  status: 'processing' | 'succeeded' | 'failed';
  providerReference: string | null;
  raw: unknown;
}

export interface NormalizedPaymentEvent {
  /** Provider-unique identifier used for inbox deduplication. */
  dedupeKey: string;
  type: 'charge.success' | 'charge.failed' | 'refund.processed' | 'refund.failed' | 'transfer.success' | 'transfer.failed' | 'other';
  reference: string | null;
  raw: unknown;
}

/**
 * Collection/refund/transfer adapter. Implementations must never be treated as escrow: whether funds can be
 * held and released on delivery depends on an approved provider arrangement (decision D04).
 */
export interface PaymentProvider {
  readonly name: 'sandbox' | 'paystack';
  /** True for non-production adapters; UI must label these clearly. */
  readonly isSandbox: boolean;
  initialize(input: InitializePaymentInput): Promise<InitializePaymentResult>;
  verify(reference: string): Promise<VerifyPaymentResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  transfer(input: TransferInput): Promise<TransferResult>;
  verifyWebhookSignature(rawBody: string, headers: Headers | Record<string, string | undefined>): boolean;
  parseWebhook(rawBody: string): NormalizedPaymentEvent;
}

export function headerValue(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, string | undefined>;
  return rec[name] ?? rec[name.toLowerCase()];
}
