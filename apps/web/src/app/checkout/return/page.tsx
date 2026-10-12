import { redirect } from 'next/navigation';
import { applyVerifiedPayment } from '@thrift/application';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx } from '@/server/session';

export const metadata = { title: 'Confirming payment' };
export const dynamic = 'force-dynamic';

/**
 * Where the payment provider sends the buyer back. The query string is never trusted: we verify the reference with
 * the provider server-side (idempotently — the webhook may already have applied it) and then show the order.
 */
export default async function PaymentReturnPage({ searchParams }: { searchParams: Promise<{ reference?: string; trxref?: string }> }) {
  const sp = await searchParams;
  const reference = (sp.reference ?? sp.trxref ?? '').slice(0, 100);
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(reference)) redirect(routes.orders);
  const result = await applyVerifiedPayment(await getCtx(), reference);
  if (result.orderId) {
    const paidLike = ['paid', 'already_applied', 'late_reallocated', 'late_refunded', 'duplicate_refunded'].includes(result.outcome);
    redirect(paidLike ? `${routes.order(result.orderId)}?payment=${result.outcome}` : routes.checkout.order(result.orderId));
  }
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <PageHeader title="We couldn’t match that payment" />
      <Alert tone="warning">
        We couldn’t find a payment with that reference yet. If money left your account, it will be confirmed or refunded automatically — check your orders in a few minutes.
      </Alert>
      <div className="mt-4">
        <ButtonLink href={routes.orders}>Go to my orders</ButtonLink>
      </div>
    </div>
  );
}
