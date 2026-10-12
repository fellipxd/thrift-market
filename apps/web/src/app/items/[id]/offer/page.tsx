import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getOfferContext, type OfferContext } from '@thrift/application';
import { formatNaira, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Photo } from '@/components/ui/Photo';
import { routes } from '@/lib/routes';
import { getCtx, requireVerifiedPage } from '@/server/session';
import { makeOfferAction } from '../../../inbox/actions';

export const metadata = { title: 'Make an offer' };
export const dynamic = 'force-dynamic';

export default async function MakeOfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireVerifiedPage(routes.itemOffer(id));
  let c: OfferContext;
  try {
    c = await getOfferContext(await getCtx(), id);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  const pending = c.openThread?.pending;
  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      <PageHeader eyebrow="Make an offer" title={c.listing.title} />
      <Card className="mb-4 flex gap-3 p-3">
        <div className="h-20 w-16 flex-none overflow-hidden rounded-md bg-sand">{c.listing.photoUrl && <Photo src={c.listing.photoUrl} alt={c.listing.title} className="h-full w-full" />}</div>
        <div className="text-sm">
          <p>
            Asking price <span className="font-semibold">{formatNaira(c.listing.priceMinor)}</span>
          </p>
          <p className="text-muted">
            from <Link href={routes.shop(c.listing.shopSlug)} className="underline">{c.listing.shopName}</Link>
            {c.listing.conditionLabel && ` · ${c.listing.conditionLabel}`}
          </p>
        </div>
      </Card>
      {c.openThread?.checkoutPath ? (
        <Alert tone="success" title="Your offer was accepted">
          <span className="block">The piece is held for you.</span>
          <ButtonLink href={c.openThread.checkoutPath} className="mt-2">Continue to checkout</ButtonLink>
        </Alert>
      ) : pending ? (
        <Alert tone="info" title={`${pending.fromParty === 'buyer' ? 'Your offer' : 'The seller’s counteroffer'} of ${formatNaira(pending.amountMinor)} is waiting for a reply`}>
          <span className="block">Continue the negotiation in your conversation with the seller.</span>
          {c.openThread?.conversationId && <ButtonLink href={routes.conversation(c.openThread.conversationId)} className="mt-2" variant="secondary">Open conversation</ButtonLink>}
        </Alert>
      ) : c.blocked ? (
        <Alert tone="warning">{c.blocked}</Alert>
      ) : (
        <Card className="p-4">
          <ActionForm action={makeOfferAction} refreshOnSuccess={false} className="space-y-4">
            <input type="hidden" name="listingId" value={c.listing.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID().replace(/-/g, '')} />
            <TextField label="Your offer (₦)" name="amount" inputMode="numeric" required placeholder="e.g. 8000" hint="For the item only. Delivery and any fees are added at checkout." />
            <TextField label="Note to the seller (optional)" name="note" maxLength={280} placeholder="e.g. Can pick up this weekend" />
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              <li>The seller has {c.expiryHours} hours to accept, counter or decline.</li>
              <li>An offer doesn’t hold the item. If the seller accepts, it’s reserved for you for a short time while you pay.</li>
              <li>You can make up to {c.maxOffersPerDay} offers a day on an item ({c.offersLeftToday} left today).</li>
            </ul>
            <SubmitButton size="lg" className="w-full" pendingText="Sending…">Send offer</SubmitButton>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
