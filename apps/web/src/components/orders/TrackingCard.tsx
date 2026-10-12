import type { OrderTracking } from '@thrift/application';
import { formatWat } from '@thrift/domain';
import { Alert } from '@/components/ui/Alert';
import { Badge, type Tone } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';

const CONFIDENCE_TONE: Record<string, Tone> = { none: 'neutral', seller_reported: 'warning', courier_verified: 'info', buyer_confirmed: 'success', staff_verified: 'success' };

const STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting for dispatch',
  booked: 'Booked',
  picked_up: 'Picked up',
  in_transit: 'On its way',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Delivery problem',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

/** Delivery tracking: who reported each milestone, how confident we are, and the expected window. Not live GPS. */
export function TrackingCard({ t, children }: { t: OrderTracking; children?: React.ReactNode }) {
  const methodText = t.method === 'integrated' ? 'Platform courier' : t.method === 'pickup' ? 'Collection from the seller' : 'Seller-arranged delivery';
  return (
    <CardSection title="Delivery tracking" action={<Badge tone={CONFIDENCE_TONE[t.confidence] ?? 'neutral'}>{t.confidenceLabel}</Badge>}>
      <div className="space-y-3 text-sm">
        <p>
          <span className="text-lg font-semibold">{t.method === 'pickup' && t.status === 'booked' ? 'Ready for collection' : (STATUS_TEXT[t.status] ?? t.status)}</span>
          <span className="block text-muted">
            {methodText}
            {t.carrierName && ` · ${t.carrierName}`}
            {t.trackingReference && ` · ref ${t.trackingReference}`}
          </span>
        </p>
        {t.exception && <Alert tone="warning" title="The courier reported a problem">We’ll keep you updated. If it isn’t resolved, you can report it from this page.</Alert>}
        {t.late && !t.exception && t.status !== 'delivered' && (
          <Alert tone="warning">{t.dispatchedAt ? 'This delivery is taking longer than expected.' : 'This order hasn’t been dispatched on time.'}</Alert>
        )}
        <dl className="grid grid-cols-2 gap-2 text-xs">
          {!t.dispatchedAt && t.dispatchBy && (
            <div>
              <dt className="text-muted">Dispatch by</dt>
              <dd className="font-medium">{formatWat(t.dispatchBy)}</dd>
            </div>
          )}
          {t.dispatchedAt && (
            <div>
              <dt className="text-muted">Dispatched</dt>
              <dd className="font-medium">{formatWat(t.dispatchedAt)}</dd>
            </div>
          )}
          {t.expectedBy && t.status !== 'delivered' && (
            <div>
              <dt className="text-muted">Expected by</dt>
              <dd className="font-medium">{formatWat(t.expectedBy)}</dd>
            </div>
          )}
          {t.deliveredAt && (
            <div>
              <dt className="text-muted">Delivered</dt>
              <dd className="font-medium">{formatWat(t.deliveredAt)}</dd>
            </div>
          )}
          {t.lastUpdateAt && (
            <div>
              <dt className="text-muted">Last update</dt>
              <dd className="font-medium">{formatWat(t.lastUpdateAt)}</dd>
            </div>
          )}
        </dl>
        {t.proofPhoto && (
          <a href={t.proofPhoto.url} target="_blank" rel="noreferrer" className="inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={t.proofPhoto.thumbUrl} alt="Dispatch proof photo" className="h-24 rounded-md" />
          </a>
        )}
        {t.events.length > 0 && (
          <ol className="space-y-2 border-l-2 border-line pl-4" aria-label="Tracking history">
            {t.events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="font-medium">{e.label}</span> <span className="text-xs text-muted">· {e.sourceLabel}</span>
                {e.description && e.description !== e.label && <span className="block text-xs text-muted">{e.description}</span>}
                <span className="block text-xs text-muted">{formatWat(e.at)}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted">
          Milestone tracking, not live GPS.{t.method === 'seller_arranged' && ' Updates for seller-arranged delivery come from the seller until the buyer confirms.'}
        </p>
        {children}
      </div>
    </CardSection>
  );
}
