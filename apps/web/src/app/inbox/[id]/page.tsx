import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getConversation, type ConversationDetail } from '@thrift/application';
import { formatNaira, isDomainError } from '@thrift/domain';
import { ConversationThread } from '@/components/messaging/ConversationThread';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Photo } from '@/components/ui/Photo';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { blockAction, respondToOfferAction, sendMessageAction, unblockAction } from '../actions';

export const metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

const LISTING_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  active: { label: 'Available', tone: 'success' },
  reserved: { label: 'Reserved', tone: 'warning' },
  sold: { label: 'Sold', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'neutral' },
  ended: { label: 'Ended', tone: 'neutral' },
  scheduled: { label: 'Coming soon', tone: 'neutral' },
};

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string }> }) {
  const { id } = await params;
  const { sent } = await searchParams;
  await requireUserPage(routes.conversation(id));
  let c: ConversationDetail;
  try {
    c = await getConversation(await getCtx(), id);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  const status = c.listing ? (LISTING_STATUS[c.listing.status] ?? { label: c.listing.status, tone: 'neutral' as const }) : null;
  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Link href={c.role === 'seller' ? `${routes.inbox}?tab=selling` : routes.inbox} className="text-sm font-semibold text-primary underline">
          ← Inbox
        </Link>
        {c.block.byViewer ? (
          <ActionForm action={unblockAction} showSuccess={false}>
            <input type="hidden" name="conversationId" value={c.id} />
            <SubmitButton variant="ghost" size="sm">Unblock</SubmitButton>
          </ActionForm>
        ) : (
          <ActionForm action={blockAction} showSuccess={false}>
            <input type="hidden" name="conversationId" value={c.id} />
            <SubmitButton variant="ghost" size="sm">{c.role === 'buyer' ? 'Block shop' : 'Block buyer'}</SubmitButton>
          </ActionForm>
        )}
      </div>
      <h1 className="display mb-4 text-3xl text-ink">
        {c.role === 'buyer' ? (
          <Link href={routes.shop(c.shop.slug)} className="hover:underline">{c.counterpartName}</Link>
        ) : (
          c.counterpartName
        )}
      </h1>
      {c.listing && (
        <Card className="mb-4 flex items-center gap-3 p-3">
          <div className="h-16 w-14 flex-none overflow-hidden rounded-md bg-sand">{c.listing.photoUrl && <Photo src={c.listing.photoUrl} alt={c.listing.title} className="h-full w-full" />}</div>
          <div className="min-w-0 flex-1">
            <Link href={routes.item(c.listing.id)} className="line-clamp-1 font-semibold text-ink hover:underline">{c.listing.title}</Link>
            <p className="text-sm text-muted">
              {c.listing.priceMinor ? formatNaira(c.listing.priceMinor) : 'Auction'}
              {c.listing.negotiable && ' · open to offers'}
            </p>
          </div>
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
        </Card>
      )}
      {c.order && (
        <Alert tone="info" className="mb-4">
          Linked to order <Link href={c.role === 'buyer' ? routes.order(c.order.id) : routes.sell.order(c.order.id)} className="font-semibold underline">{c.order.number}</Link>.
        </Alert>
      )}
      {sent === 'offer' && (
        <Alert tone="success" className="mb-4">
          Offer sent. It doesn’t hold the item until the seller accepts it.
        </Alert>
      )}
      <ConversationThread
        conversationId={c.id}
        role={c.role}
        listing={c.listing ? { id: c.listing.id, negotiable: c.listing.negotiable, available: c.listing.available, status: c.listing.status } : null}
        initialMessages={c.messages}
        initialOfferThreads={c.offerThreads}
        initialBlocked={c.block.blocked}
        serverNow={c.serverNow}
        clientKey={randomUUID().replace(/-/g, '')}
        sendAction={sendMessageAction}
        offerAction={respondToOfferAction}
      />
    </div>
  );
}
