import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getOrderDetail, type OrderDetail } from '@thrift/application';
import { formatWat, isDomainError } from '@thrift/domain';
import { FulfilmentBadge, PaymentBadge } from '@/components/orders/OrderStatusBadges';
import { OrderDelivery, OrderItems, OrderTimeline, OrderTotals } from '@/components/orders/OrderSummary';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { OrderDisputePanel } from './dispute-panel';
import { OrderFulfilmentPanel } from './fulfilment-panel';
import { OrderReviewPanel } from './review-panel';

export const metadata = { title: 'Order' };

const PAYMENT_NOTICE: Record<string, { tone: 'success' | 'info' | 'warning'; text: string }> = {
  paid: { tone: 'success', text: 'Payment confirmed. The seller has been told to dispatch your order.' },
  already_applied: { tone: 'success', text: 'Payment confirmed. The seller has been told to dispatch your order.' },
  late_reallocated: { tone: 'success', text: 'Your payment arrived after the hold ended, but the piece was still available — it’s yours.' },
  late_refunded: { tone: 'warning', text: 'Your payment arrived after the hold ended and the piece had already gone. A full refund has been started.' },
  duplicate_refunded: { tone: 'info', text: 'This order was already paid. The extra payment is being refunded to you automatically.' },
};

const CANCEL_REASON: Record<string, string> = {
  buyer_cancelled_unpaid: 'You cancelled this order before paying.',
  hold_expired_unpaid: 'The hold ended before a payment was confirmed, so the piece was released.',
  item_unavailable_at_payment: 'Your payment arrived after the hold ended and the piece had gone. Your payment is being refunded.',
};

function cancelText(reason: string): string {
  if (reason.startsWith('seller: ')) return `The seller cancelled this order: ${reason.slice(8)}. A full refund has been started.`;
  return CANCEL_REASON[reason] ?? 'This order was cancelled.';
}

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ payment?: string }> }) {
  const { id } = await params;
  const { payment } = await searchParams;
  await requireUserPage(routes.order(id));
  let order: OrderDetail;
  try {
    order = await getOrderDetail(await getCtx(), id);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  if (order.viewer === 'seller') redirect(routes.sell.order(order.id));
  const notice = payment ? PAYMENT_NOTICE[payment] : undefined;
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader
        eyebrow={`Order ${order.number} · placed ${formatWat(order.createdAt)}`}
        title={order.items[0]?.title ?? 'Order'}
        description={
          <span>
            from <Link href={routes.shop(order.shop.slug)} className="underline">{order.shop.name}</Link>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-1">
            <PaymentBadge status={order.paymentStatus} label={order.paymentLabel} />
            {order.status !== 'pending_payment' && <FulfilmentBadge status={order.fulfilmentStatus} label={order.fulfilmentLabel} />}
          </div>
        }
      />
      {notice && (
        <Alert tone={notice.tone} className="mb-4">
          {notice.text}
        </Alert>
      )}
      {order.status === 'pending_payment' && (
        <Alert tone="warning" title="Waiting for payment" className="mb-4">
          <span className="block">This order isn’t paid yet.</span>
          <ButtonLink href={routes.checkout.order(order.id)} size="sm" className="mt-2">Complete payment</ButtonLink>
        </Alert>
      )}
      {order.status === 'cancelled' && order.cancelReason && (
        <Alert tone="info" title="Order cancelled" className="mb-4">
          {cancelText(order.cancelReason)}
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <OrderFulfilmentPanel order={order} />
          <OrderItems order={order} />
          <OrderDelivery order={order} />
          <OrderDisputePanel order={order} />
          <OrderReviewPanel order={order} />
        </div>
        <div className="space-y-6">
          <OrderTotals order={order} />
          <OrderTimeline order={order} />
          {order.status !== 'pending_payment' && (
            <ButtonLink href={routes.orderConversation(order.id)} variant="secondary" className="w-full">Message the seller</ButtonLink>
          )}
          <p className="text-xs text-muted">
            Your payment is held by Thrift Market and only released to the seller after delivery is confirmed. Need help?{' '}
            <Link href="/help" className="underline">Contact support</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
