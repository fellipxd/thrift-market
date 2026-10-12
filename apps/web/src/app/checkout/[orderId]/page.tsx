import { notFound, redirect } from 'next/navigation';
import { getOrderDetail, type OrderDetail } from '@thrift/application';
import { formatNaira, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Countdown } from '@/components/ui/Countdown';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { cancelPendingOrderAction, retryPaymentAction } from '../actions';

export const metadata = { title: 'Complete payment' };

export default async function PendingPaymentPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  await requireUserPage(routes.checkout.order(orderId));
  let o: OrderDetail;
  try {
    o = await getOrderDetail(await getCtx(), orderId);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  if (o.viewer !== 'buyer' || o.status !== 'pending_payment') redirect(o.viewer === 'buyer' ? routes.order(o.id) : routes.sell.order(o.id));
  const holdActive = !!o.reservation && ['active', 'payment_pending'].includes(o.reservation.status) && new Date(o.reservation.expiresAt) > new Date(o.serverNow);
  const item = o.items[0];
  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      <PageHeader eyebrow={`Order ${o.number}`} title="Complete your payment" />
      <Card className="space-y-4 p-4">
        <div>
          <p className="font-semibold">{item?.title}</p>
          <p className="text-sm text-muted">from {o.shop.name}</p>
        </div>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-muted">Item{o.items.length > 1 || (item && item.quantity > 1) ? 's' : ''}</dt><dd>{formatNaira(o.totals.itemsTotalMinor)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">Delivery · {o.delivery.methodLabel}</dt><dd>{o.totals.shippingMinor === 0 ? 'Free' : formatNaira(o.totals.shippingMinor)}</dd></div>
          {o.totals.buyerFeeMinor > 0 && <div className="flex justify-between"><dt className="text-muted">Buyer protection fee</dt><dd>{formatNaira(o.totals.buyerFeeMinor)}</dd></div>}
          <div className="flex justify-between border-t border-line pt-2 text-base font-semibold"><dt>Total</dt><dd>{formatNaira(o.totals.totalMinor)}</dd></div>
        </dl>
        {o.reservation && holdActive ? (
          <Alert tone="info" title="Held for you">
            Pay within <Countdown target={o.reservation.expiresAt} serverNow={o.serverNow} expiredText="— the hold has ended" /> to keep this piece.
            {o.reservation.status === 'payment_pending' && ' Your payment is being confirmed, so we’ve extended the hold.'}
          </Alert>
        ) : (
          <Alert tone="warning" title="Hold ended">The reservation has ended. If a payment you made is confirmed, we’ll either complete the order or refund you automatically.</Alert>
        )}
        {o.payment.latestStatus === 'pending' || o.payment.latestStatus === 'uncertain' ? (
          <Alert tone="info" title="Already paid?">If you’ve completed payment, it can take a moment to confirm. Check the order status before paying again — you won’t be charged twice for the same order.</Alert>
        ) : o.payment.latestStatus === 'failed' || o.payment.latestStatus === 'abandoned' ? (
          <Alert tone="error" title="Payment not completed">Your last payment attempt didn’t go through. You can try again while the hold lasts.</Alert>
        ) : null}
        <div className="flex flex-col gap-2">
          {o.payment.authorizationUrl && holdActive && (
            <ButtonLink href={o.payment.authorizationUrl} size="lg" prefetch={false}>Pay {formatNaira(o.totals.totalMinor)}</ButtonLink>
          )}
          {o.payment.canRetry && (
            <ActionForm action={retryPaymentAction} refreshOnSuccess={false}>
              <input type="hidden" name="orderId" value={o.id} />
              <SubmitButton variant={o.payment.authorizationUrl ? 'secondary' : 'primary'} size="lg" className="w-full" pendingText="Checking payment…">
                {o.payment.authorizationUrl ? 'Check status / try again' : 'Try payment again'}
              </SubmitButton>
            </ActionForm>
          )}
          <ButtonLink href={routes.order(o.id)} variant="ghost">View order status</ButtonLink>
        </div>
        <ActionForm action={cancelPendingOrderAction} refreshOnSuccess={false} className="border-t border-line pt-4">
          <input type="hidden" name="orderId" value={o.id} />
          <p className="mb-2 text-sm text-muted">Changed your mind? Cancelling releases the hold so someone else can buy it.</p>
          <SubmitButton variant="ghost" pendingText="Cancelling…">Cancel this order</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
