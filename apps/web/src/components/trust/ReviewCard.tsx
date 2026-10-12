import type { ReviewView } from '@thrift/application';
import { formatWatDate } from '@thrift/domain';
import { Badge } from '@/components/ui/Badge';
import { Stars } from './Stars';

export function ReviewCard({ r, children }: { r: ReviewView; children?: React.ReactNode }) {
  return (
    <article className="rounded-[var(--radius-card)] border border-line bg-surface p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <Stars value={r.overall} label="Overall" /> <span className="font-semibold">{r.authorName}</span>
          <span className="text-muted"> · {formatWatDate(r.createdAt)}</span>
        </p>
        <span className="flex gap-1">
          <Badge tone="success">Verified purchase</Badge>
          {r.status !== 'published' && <Badge tone="warning">{r.status === 'hidden' ? 'Hidden by moderation' : 'Removed'}</Badge>}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">Bought: {r.itemTitle}</p>
      <p className="mt-1 text-xs text-muted">
        As described {r.accuracy}/5 · Communication {r.communication}/5 · Delivery {r.delivery}/5
      </p>
      {r.body && <p className="mt-2 whitespace-pre-line">{r.body}</p>}
      {r.sellerReply && (
        <div className="mt-3 rounded-md bg-sand p-3">
          <p className="text-xs font-semibold">Seller’s reply</p>
          <p className="whitespace-pre-line">{r.sellerReply}</p>
        </div>
      )}
      {children}
    </article>
  );
}
