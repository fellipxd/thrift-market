import Link from 'next/link';
import type { ConversationSummary } from '@thrift/application';
import { formatNaira, formatWat } from '@thrift/domain';
import { Badge } from '@/components/ui/Badge';
import { Photo } from '@/components/ui/Photo';
import { cx } from '@/lib/format';
import { routes } from '@/lib/routes';

const OFFER_BADGE: Record<string, string> = {
  open: 'Offer in progress',
  accepted: 'Offer accepted',
  completed: 'Bought',
};

export function ConversationList({ items }: { items: ConversationSummary[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      {items.map((c) => (
        <li key={c.id}>
          <Link href={routes.conversation(c.id)} className={cx('flex gap-3 p-3 hover:bg-primary-soft/40', c.unread > 0 && 'bg-primary-soft/30')}>
            <div className="h-14 w-12 flex-none overflow-hidden rounded-md bg-sand">{c.listing?.photoUrl && <Photo src={c.listing.photoUrl} alt="" className="h-full w-full" />}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className={cx('line-clamp-1 text-ink', c.unread > 0 ? 'font-bold' : 'font-semibold')}>{c.counterpartName}</p>
                <time dateTime={c.lastMessageAt} className="whitespace-nowrap text-xs text-muted">{formatWat(c.lastMessageAt).replace(' WAT', '')}</time>
              </div>
              <p className="line-clamp-1 text-xs text-muted">
                {c.listing ? `${c.listing.title}${c.listing.priceMinor ? ` · ${formatNaira(c.listing.priceMinor)}` : ''}` : 'Order conversation'}
              </p>
              <div className="mt-0.5 flex items-center gap-2">
                <p className={cx('line-clamp-1 flex-1 text-sm', c.unread > 0 ? 'text-ink' : 'text-muted')}>{c.lastMessagePreview}</p>
                {c.offerStatus && OFFER_BADGE[c.offerStatus] && <Badge tone="accent">{OFFER_BADGE[c.offerStatus]}</Badge>}
                {c.unread > 0 && (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-white" aria-label={`${c.unread} unread`}>
                    {c.unread}
                  </span>
                )}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
