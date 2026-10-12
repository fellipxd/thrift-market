import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, shopOffers, type ShopOfferFilter } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Countdown } from '@/components/ui/Countdown';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Photo } from '@/components/ui/Photo';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { respondToOfferAction } from '../../inbox/actions';

export const metadata = { title: 'Offers' };
export const dynamic = 'force-dynamic';

const TABS: { key: ShopOfferFilter; label: string }[] = [
  { key: 'needs_response', label: 'To review' },
  { key: 'awaiting_buyer', label: 'Waiting on buyer' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

export default async function SellerOffersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUserPage(routes.sell.offers);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const sp = await searchParams;
  const active = (TABS.find((t) => t.key === sp.status)?.key ?? 'needs_response') as ShopOfferFilter;
  const res = await shopOffers(await getCtx(), { status: active });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Offers & chat"
        description="Reply before offers expire. Accepting reserves the piece for the buyer at that price while they pay."
        actions={<ButtonLink href={withQuery(routes.inbox, { tab: 'selling' })} variant="secondary">Shop conversations</ButtonLink>}
      />
      <nav aria-label="Filter offers" className="-mx-1 overflow-x-auto">
        <ul className="flex gap-1 px-1 pb-1">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={withQuery(routes.sell.offers, { status: t.key === 'needs_response' ? undefined : t.key })}
                aria-current={active === t.key ? 'page' : undefined}
                className={cx('inline-flex min-h-10 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold', active === t.key ? 'bg-primary text-white' : 'bg-surface text-ink')}
              >
                {t.label} <span className="ml-1 opacity-80">{res.counts[t.key]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {res.items.length === 0 ? (
        <EmptyState title={active === 'needs_response' ? 'No offers waiting for you' : 'Nothing here'}>
          {active === 'needs_response' ? 'Offers on your negotiable items appear here with the time left to reply.' : 'Try another tab.'}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {res.items.map((i) => {
            const pending = i.latest?.status === 'pending' ? i.latest : null;
            const toReview = pending?.fromParty === 'buyer' && i.status === 'open';
            return (
              <li key={i.threadId}>
                <Card className="flex flex-col gap-3 p-3 sm:flex-row">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <div className="h-20 w-16 flex-none overflow-hidden rounded-md bg-sand">{i.listing.photoUrl && <Photo src={i.listing.photoUrl} alt="" className="h-full w-full" />}</div>
                    <div className="min-w-0 text-sm">
                      <Link href={routes.sell.listing(i.listing.id)} className="line-clamp-1 font-semibold text-ink hover:underline">{i.listing.title}</Link>
                      <p className="text-muted">Asking {i.listing.priceMinor ? formatNaira(i.listing.priceMinor) : '—'} · {i.buyerName}</p>
                      {i.latest && (
                        <p className="mt-1">
                          <span className="font-serif text-xl text-ink">{formatNaira(i.latest.amountMinor)}</span>{' '}
                          <span className="text-muted">{i.latest.fromParty === 'buyer' ? 'from buyer' : 'your counter'}</span>
                        </p>
                      )}
                      <p className="text-xs text-muted">
                        <Badge tone={i.status === 'accepted' ? 'success' : i.status === 'open' ? 'accent' : 'neutral'}>{i.statusLabel}</Badge>
                        {pending && (
                          <>
                            {' '}
                            expires in <Countdown target={pending.expiresAt} serverNow={res.serverNow} expiredText="moments" />
                          </>
                        )}
                        {i.reservationExpiresAt && (
                          <>
                            {' '}
                            reserved for <Countdown target={i.reservationExpiresAt} serverNow={res.serverNow} expiredText="— hold ended" />
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:w-64">
                    {toReview && pending && (
                      <>
                        <ActionForm action={respondToOfferAction} className="flex gap-2">
                          <input type="hidden" name="offerId" value={pending.id} />
                          <SubmitButton name="action" value="accept" size="sm">Accept</SubmitButton>
                          <SubmitButton name="action" value="reject" variant="ghost" size="sm">Decline</SubmitButton>
                        </ActionForm>
                        <ActionForm action={respondToOfferAction} className="flex items-end gap-2">
                          <input type="hidden" name="offerId" value={pending.id} />
                          <input type="hidden" name="action" value="counter" />
                          <label className="flex-1 text-xs font-medium">
                            Counter (₦)
                            <input name="counterAmount" inputMode="numeric" required className="mt-1 block w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-2 py-1.5 text-sm" />
                          </label>
                          <SubmitButton variant="secondary" size="sm">Counter</SubmitButton>
                        </ActionForm>
                      </>
                    )}
                    {i.conversationId && <ButtonLink href={routes.conversation(i.conversationId)} variant="ghost" size="sm">Open conversation</ButtonLink>}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
