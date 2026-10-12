import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, shopAuctions } from '@thrift/application';
import { formatNaira, formatWat } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Countdown } from '@/components/ui/Countdown';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Photo } from '@/components/ui/Photo';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { cancelAuctionAction, offerSecondChanceAction } from './actions';

export const metadata = { title: 'Auctions' };
export const dynamic = 'force-dynamic';

const TONE: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
  live: 'success',
  scheduled: 'info',
  awaiting_payment: 'warning',
  failed_unpaid: 'warning',
  paid: 'success',
};

export default async function SellerAuctionsPage({ searchParams }: { searchParams: Promise<{ scheduled?: string }> }) {
  const user = await requireUserPage(routes.sell.auctions);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const { scheduled } = await searchParams;
  const res = await shopAuctions(await getCtx());
  return (
    <div className="space-y-5">
      <PageHeader
        title="Auctions"
        description="Schedule single-piece auctions from your drafts. Terms are locked once the first bid arrives."
        actions={<ButtonLink href={routes.sell.newAuction()}>Schedule an auction</ButtonLink>}
      />
      {scheduled && <Alert tone="success">Auction scheduled. Followers will be told when it goes live.</Alert>}
      {res.items.length === 0 ? (
        <EmptyState title="No auctions yet" action={<ButtonLink href={routes.sell.newAuction()}>Schedule an auction</ButtonLink>}>
          Create a draft listing with photos and condition details, then schedule it here with a start time, opening price and bid increment.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {res.items.map((a) => (
            <li key={a.id}>
              <Card className="flex flex-col gap-3 p-3 sm:flex-row">
                <div className="flex min-w-0 flex-1 gap-3">
                  <div className="h-20 w-16 flex-none overflow-hidden rounded-md bg-sand">{a.photoUrl && <Photo src={a.photoUrl} alt="" className="h-full w-full" />}</div>
                  <div className="min-w-0 text-sm">
                    <Link href={routes.auction(a.id)} className="line-clamp-1 font-semibold text-ink hover:underline">{a.title}</Link>
                    <p>
                      <Badge tone={TONE[a.status] ?? 'neutral'}>{a.statusLabel}</Badge>{' '}
                      <span className="text-muted">
                        {a.bidCount} bid{a.bidCount === 1 ? '' : 's'} · {a.currentBidMinor ? `current ${formatNaira(a.currentBidMinor)}` : `opens at ${formatNaira(a.openingPriceMinor)}`}
                      </span>
                    </p>
                    <p className="text-xs text-muted">
                      {a.status === 'scheduled' ? `Starts ${formatWat(a.startsAt)}` : a.status === 'live' ? (
                        <>
                          Ends {formatWat(a.endsAt)} · <Countdown target={a.endsAt} serverNow={res.serverNow} expiredText="ending" /> left
                        </>
                      ) : (
                        `Ended ${formatWat(a.endsAt)}`
                      )}
                    </p>
                    {a.paymentDeadline && a.status === 'awaiting_payment' && <p className="text-xs text-muted">Winner pays by {formatWat(a.paymentDeadline)}. Don’t send the item until the order is paid.</p>}
                    {a.secondChance && (
                      <p className="text-xs text-muted">
                        Second chance at {formatNaira(a.secondChance.amountMinor)}: {a.secondChance.status}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:w-64">
                  {a.canCancel && (
                    <ActionForm action={cancelAuctionAction} className="flex items-end gap-2">
                      <input type="hidden" name="auctionId" value={a.id} />
                      <label className="flex-1 text-xs font-medium">
                        Reason
                        <input name="reason" required className="mt-1 block w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-2 py-1.5 text-sm" />
                      </label>
                      <SubmitButton variant="ghost" size="sm">Cancel</SubmitButton>
                    </ActionForm>
                  )}
                  {a.canOfferSecondChance && (
                    <ActionForm action={offerSecondChanceAction}>
                      <input type="hidden" name="auctionId" value={a.id} />
                      <SubmitButton variant="secondary" size="sm">Offer second chance to runner-up</SubmitButton>
                    </ActionForm>
                  )}
                  {a.canRelist && <ButtonLink href={withQuery(routes.sell.newAuction(), { relist: a.id })} variant="secondary" size="sm">Relist</ButtonLink>}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
