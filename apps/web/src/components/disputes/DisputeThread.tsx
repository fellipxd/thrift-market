import type { DisputeView } from '@thrift/application';
import { formatNaira, formatWat } from '@thrift/domain';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/lib/format';

export function DisputeHeader({ d }: { d: DisputeView }) {
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="font-semibold">{d.reasonLabel}</span> · opened {formatWat(d.createdAt)}
      </p>
      <p>
        <Badge tone={d.status === 'resolved' || d.status === 'withdrawn' ? 'neutral' : 'warning'}>{d.statusLabel}</Badge>
        {d.outcome && d.outcome !== 'withdrawn' && (
          <span className="ml-2 text-muted">
            Outcome: {d.outcome.replace(/_/g, ' ')}
            {d.refundAmountMinor ? ` · ${formatNaira(d.refundAmountMinor)}` : ''}
          </span>
        )}
      </p>
      {d.respondBy && (d.status === 'awaiting_seller' || d.status === 'awaiting_buyer') && <p className="text-xs text-muted">Response due by {formatWat(d.respondBy)}.</p>}
      {d.resolutionNote && <p className="text-muted">{d.resolutionNote}</p>}
    </div>
  );
}

export function DisputeThread({ d }: { d: DisputeView }) {
  return (
    <ol className="space-y-3" aria-label="Dispute history">
      {d.entries.map((e) => (
        <li key={e.id} className={cx('rounded-[var(--radius-card)] border p-3 text-sm', e.internal ? 'border-warning/40 bg-warning-soft' : 'border-line bg-surface')}>
          <p className="text-xs font-semibold text-muted">
            {e.roleLabel}
            {e.internal && ' · internal note (not visible to buyer or seller)'} · {formatWat(e.at)}
          </p>
          <p className="mt-1 whitespace-pre-line">{e.body}</p>
          {e.photos.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {e.photos.map((p, i) => (
                <a key={i} href={p.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.thumbUrl} alt={`Evidence photo ${i + 1}`} className="h-20 w-20 rounded-md object-cover" />
                </a>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
