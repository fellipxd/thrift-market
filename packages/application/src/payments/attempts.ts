import { maybeOne, one, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';
import { paymentReference } from '../core/ids';

export interface PaymentAttemptRow {
  id: string;
  purpose: 'order' | 'ad_campaign';
  order_id: string | null;
  ad_campaign_id: string | null;
  payer_user_id: string;
  provider: 'sandbox' | 'paystack';
  reference: string;
  amount_minor: number;
  currency: string;
  status: 'initiated' | 'pending' | 'uncertain' | 'succeeded' | 'failed' | 'abandoned' | 'duplicate';
  authorization_url: string | null;
  created_at: Date;
  [k: string]: unknown;
}

/** Records a payment attempt before calling the provider (status initiated). */
export async function createPaymentAttempt(
  tx: Queryable,
  ctx: AppContext,
  args: { orderId?: string | null; adCampaignId?: string | null; payerUserId: string; amountMinor: number },
): Promise<PaymentAttemptRow> {
  return one<PaymentAttemptRow>(
    tx,
    `INSERT INTO payment_attempts (purpose, order_id, ad_campaign_id, payer_user_id, provider, reference, amount_minor)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      args.orderId ? 'order' : 'ad_campaign',
      args.orderId ?? null,
      args.adCampaignId ?? null,
      args.payerUserId,
      ctx.providers.payments.name,
      paymentReference(args.orderId ? 'TMO' : 'TMA'),
      args.amountMinor,
    ],
  );
}

/**
 * Calls the provider for a recorded attempt (outside any transaction). Success → pending with the hosted
 * payment URL. Any error/timeout → uncertain: the outcome is unknown, so reconciliation verifies it later and the
 * buyer is told to check the order status before paying again.
 */
export async function initializePaymentAttempt(
  ctx: AppContext,
  attemptId: string,
  meta: { callbackPath: string; description: string },
): Promise<{ authorizationUrl: string | null; status: 'pending' | 'uncertain' }> {
  const a = await one<PaymentAttemptRow & { email: string | null }>(
    ctx.pool,
    `SELECT pa.*, u.email FROM payment_attempts pa JOIN users u ON u.id = pa.payer_user_id WHERE pa.id = $1`,
    [attemptId],
  );
  if (a.status !== 'initiated') return { authorizationUrl: a.authorization_url, status: a.status === 'pending' ? 'pending' : 'uncertain' };
  try {
    const callbackUrl = new URL(meta.callbackPath, ctx.config.baseUrl);
    callbackUrl.searchParams.set('reference', a.reference);
    const res = await ctx.providers.payments.initialize({
      reference: a.reference,
      amountMinor: a.amount_minor,
      currency: 'NGN',
      email: a.email ?? `${a.payer_user_id}@buyers.thrift.invalid`,
      callbackUrl: callbackUrl.toString(),
      metadata: { attemptId: a.id, purpose: a.purpose, orderId: a.order_id ?? '', description: meta.description },
    });
    await ctx.pool.query(
      `UPDATE payment_attempts SET status = 'pending', authorization_url = $2, updated_at = now() WHERE id = $1 AND status = 'initiated'`,
      [a.id, res.authorizationUrl],
    );
    return { authorizationUrl: res.authorizationUrl, status: 'pending' };
  } catch (err) {
    await ctx.pool.query(
      `UPDATE payment_attempts SET status = 'uncertain', failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'initiated'`,
      [a.id, `initialize failed: ${String((err as Error).message ?? err).slice(0, 300)}`],
    );
    return { authorizationUrl: null, status: 'uncertain' };
  }
}

export async function findAttemptByReference(db: Queryable, reference: string): Promise<PaymentAttemptRow | null> {
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(reference)) return null;
  return maybeOne<PaymentAttemptRow>(db, 'SELECT * FROM payment_attempts WHERE reference = $1', [reference]);
}
