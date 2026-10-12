import { notFound, redirect } from 'next/navigation';
import { getOrderDetail, type OrderDetail } from '@thrift/application';
import { formatNaira, formatWat, isDomainError } from '@thrift/domain';
import { FulfilmentBadge, PaymentBadge } from '@/components/orders/OrderStatusBadges';
import { OrderDelivery, OrderItems, OrderTimeline, OrderTotals } from '@/components/orders/OrderSummary';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { CardSection } from '@/components/ui/Card';
import { CheckboxField, TextAreaField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { sellerCancelAction } from './actions';
import { SellerFulfilmentPanel } from './fulfilment-panel';

export const metadata = { title: 'Order' };

export default async function SellerOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireUserPage(routes.sell.order(id));
  let order: OrderDetail;
  try {
    order = await getOrderDetail(await getCtx(), id);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  if (order.viewer !== 'seller') redirect(routes.order(order.id));
  const canCancel = order.status === 'confirmed' && order.paymentStatus === 'paid' && order.fulfilmentStatus === 'awaiting_dispatch';
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Order ${order.number} · ${formatWat(order.createdAt)}`}
        title={order.items[0]?.title ?? 'Order'}
        description={`Buyer: ${order.buyerName}`}
        actions={
          <div className="flex flex-wrap gap-1">
            <PaymentBadge status={order.paymentStatus} label={order.paymentLabel} />
            {order.status !== 'pending_payment' && <FulfilmentBadge status={order.fulfilmentStatus} label={order.fulfilmentLabel} />}
          </div>
        }
      />
      {order.status === 'pending_payment' && (
        <Alert tone="info" title="Not paid yet">The buyer is completing payment. Don’t send anything until this order shows as paid.</Alert>
      )}
      {order.shipment?.dispatchBy && order.fulfilmentStatus === 'awaiting_dispatch' && order.status === 'confirmed' && (
        <Alert tone="warning" title="Ready to ship">Dispatch by {formatWat(order.shipment.dispatchBy)}. Late dispatch affects your shop’s service rating.</Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <SellerFulfilmentPanel order={order} />
          <OrderItems order={order} />
          <OrderDelivery order={order} />
          {canCancel && (
            <CardSection title="Can’t fulfil this order?">
              <ActionForm action={sellerCancelAction} className="space-y-3">
                <input type="hidden" name="orderId" value={order.id} />
                <p className="text-sm text-muted">
                  Cancelling refunds the buyer in full and counts as a seller cancellation on your shop’s service record. Only cancel if you genuinely can’t send the item.
                </p>
                <TextAreaField label="Reason (shared with the buyer)" name="reason" required rows={3} />
                <CheckboxField label="Put the item back on sale" name="restock" defaultChecked hint="Untick if the item is damaged or no longer available." />
                <SubmitButton variant="danger" pendingText="Cancelling…">Cancel and refund buyer</SubmitButton>
              </ActionForm>
            </CardSection>
          )}
        </div>
        <div className="space-y-6">
          <OrderTotals order={order} />
          {order.payout && (
            <CardSection title="Your payout">
              <p className="text-2xl font-semibold">{formatNaira(order.payout.amountMinor)}</p>
              <p className="text-sm text-muted">{order.payout.statusLabel}</p>
              {order.payout.eligibleAt && <p className="text-xs text-muted">Release from {formatWat(order.payout.eligibleAt)}</p>}
              <p className="mt-2 text-xs text-muted">Payouts are released after the buyer confirms delivery or delivery is verified — not on your own delivery report alone.</p>
            </CardSection>
          )}
          <OrderTimeline order={order} />
        </div>
      </div>
    </div>
  );
}
