import Link from 'next/link';
import type { OrderDetail } from '@thrift/application';
import { formatNaira, formatWat } from '@thrift/domain';
import { Card, CardSection } from '@/components/ui/Card';
import { Photo } from '@/components/ui/Photo';
import { routes } from '@/lib/routes';

/** What was bought (the immutable snapshot taken at checkout), the money breakdown, delivery terms and the timeline. */
export function OrderItems({ order }: { order: OrderDetail }) {
  return (
    <CardSection title="What was ordered">
      <ul className="space-y-4">
        {order.items.map((it) => (
          <li key={it.listingId} className="flex gap-3">
            <div className="h-24 w-20 flex-none overflow-hidden rounded-md bg-sand">{it.photoUrls[0] && <Photo src={it.photoUrls[0]} alt={it.title} className="h-full w-full" />}</div>
            <div className="min-w-0 text-sm">
              <Link href={routes.item(it.listingId)} className="font-semibold text-ink hover:underline">{it.title}</Link>
              <p className="text-muted">
                {[it.conditionLabel, it.sizeLabel, it.quantity > 1 ? `Qty ${it.quantity}` : null].filter(Boolean).join(' · ')} · {formatNaira(it.unitPriceMinor)}
                {it.quantity > 1 ? ' each' : ''}
              </p>
              {it.flaws.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-muted">
                  {it.flaws.map((f, i) => (
                    <li key={i}>
                      {f.description}
                      {f.location ? ` (${f.location})` : ''} — {f.severity}
                    </li>
                  ))}
                </ul>
              )}
              {it.flawsDeclaration && it.flaws.length === 0 && <p className="mt-1 text-muted">{it.flawsDeclaration}</p>}
              {it.listingVersion !== null && <p className="mt-1 text-xs text-muted">Listing details as they were at checkout (version {it.listingVersion}).</p>}
            </div>
          </li>
        ))}
      </ul>
    </CardSection>
  );
}

export function OrderTotals({ order }: { order: OrderDetail }) {
  const t = order.totals;
  return (
    <CardSection title="Payment">
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between"><dt className="text-muted">Items</dt><dd>{formatNaira(t.itemsTotalMinor)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Delivery</dt><dd>{t.shippingMinor === 0 ? 'Free' : formatNaira(t.shippingMinor)}</dd></div>
        {t.buyerFeeMinor > 0 && <div className="flex justify-between"><dt className="text-muted">Buyer fee</dt><dd>{formatNaira(t.buyerFeeMinor)}</dd></div>}
        <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Total paid by buyer</dt><dd>{formatNaira(t.totalMinor)}</dd></div>
        {order.viewer === 'seller' && (
          <div className="flex justify-between text-muted"><dt>Platform commission</dt><dd>{t.commissionMinor === 0 ? 'None' : `− ${formatNaira(t.commissionMinor)}`}</dd></div>
        )}
      </dl>
      {order.refunds.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-1 text-sm font-semibold">Refunds</p>
          <ul className="space-y-1 text-sm">
            {order.refunds.map((r) => (
              <li key={r.id} className="flex justify-between gap-2">
                <span className="text-muted">
                  {r.reason.replace(/_/g, ' ')} · {r.status === 'succeeded' ? 'confirmed' : r.status === 'rejected' ? 'declined' : 'in progress'}
                </span>
                <span>{formatNaira(r.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CardSection>
  );
}

export function OrderDelivery({ order }: { order: OrderDetail }) {
  const d = order.delivery;
  const s = order.shipment;
  return (
    <CardSection title="Delivery">
      <div className="space-y-2 text-sm">
        <p>
          <span className="font-semibold">{d.methodLabel}</span>
          {d.dispatchDays !== null && <span className="text-muted"> · ships within {d.dispatchDays} day{d.dispatchDays === 1 ? '' : 's'}</span>}
          {d.transitDaysMin !== null && d.transitDaysMax !== null && <span className="text-muted"> · {d.transitDaysMin}–{d.transitDaysMax} days in transit</span>}
        </p>
        {d.trackingNote && <p className="text-muted">{d.trackingNote}</p>}
        {s && (
          <p>
            Status: <span className="font-semibold">{s.status.replace(/_/g, ' ')}</span> <span className="text-muted">({s.confidenceLabel})</span>
            {s.trackingReference && <span className="block text-muted">Tracking reference: {s.trackingReference}</span>}
            {s.dispatchBy && s.status === 'pending' && <span className="block text-muted">Seller should dispatch by {formatWat(s.dispatchBy)}</span>}
          </p>
        )}
        {order.shippingAddress && (
          <address className="not-italic text-muted">
            {[order.shippingAddress.recipientName, order.shippingAddress.phone].filter(Boolean).join(' · ')}
            <br />
            {[order.shippingAddress.line1, order.shippingAddress.line2, order.shippingAddress.area, order.shippingAddress.city, order.shippingAddress.state].filter(Boolean).join(', ')}
            {order.shippingAddress.landmark && (
              <>
                <br />
                Landmark: {order.shippingAddress.landmark}
              </>
            )}
          </address>
        )}
      </div>
    </CardSection>
  );
}

export function OrderTimeline({ order }: { order: OrderDetail }) {
  if (order.timeline.length === 0) return null;
  return (
    <Card className="p-4">
      <h2 className="mb-3 font-serif text-xl">Timeline</h2>
      <ol className="space-y-2 border-l-2 border-line pl-4 text-sm">
        {order.timeline.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <span className="font-medium">{e.label}</span>
            <span className="block text-xs text-muted">{formatWat(e.at)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
