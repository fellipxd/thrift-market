import Link from 'next/link';
import type { OrderListItem } from '@thrift/application';
import { formatNaira, formatWatDate } from '@thrift/domain';
import { Photo } from '@/components/ui/Photo';
import { FulfilmentBadge, PaymentBadge } from './OrderStatusBadges';

export function OrderList({ items, hrefFor, counterpartLabel }: { items: OrderListItem[]; hrefFor: (id: string) => string; counterpartLabel: string }) {
  return (
    <ul className="divide-y divide-line border-y border-ink">
      {items.map((o) => (
        <li key={o.id}>
          <Link href={hrefFor(o.id)} className="flex gap-3 py-4 pr-1 hover:bg-sand/60">
            <div className="h-16 w-14 flex-none overflow-hidden rounded-md bg-sand">{o.photoUrl && <Photo src={o.photoUrl} alt="" className="h-full w-full" />}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-1 font-semibold text-ink">{o.title}</p>
                <p className="whitespace-nowrap font-semibold">{formatNaira(o.totalMinor)}</p>
              </div>
              <p className="text-xs text-muted">
                {o.number} · {formatWatDate(o.createdAt)} · {counterpartLabel} {o.counterpart}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                <PaymentBadge status={o.paymentStatus} label={o.paymentLabel} />
                {o.status !== 'pending_payment' && <FulfilmentBadge status={o.fulfilmentStatus} label={o.fulfilmentLabel} />}
                {o.status === 'cancelled' && <span className="text-xs text-muted">{o.statusLabel}</span>}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
