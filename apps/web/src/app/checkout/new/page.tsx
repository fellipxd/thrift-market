import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getCheckoutContext, type CheckoutContext } from '@thrift/application';
import { formatNaira, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardSection } from '@/components/ui/Card';
import { Countdown } from '@/components/ui/Countdown';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Photo } from '@/components/ui/Photo';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireVerifiedPage } from '@/server/session';
import { startCheckoutAction } from '../actions';

export const metadata = { title: 'Checkout' };

type Search = { listing?: string; offer?: string; auction?: string; secondChance?: string; address?: string; quantity?: string };

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const self = withQuery('/checkout/new', sp);
  await requireVerifiedPage(self);
  let c: CheckoutContext;
  try {
    c = await getCheckoutContext(await getCtx(), sp);
  } catch (err) {
    if (isDomainError(err) && (err.code === 'NOT_FOUND' || err.code === 'VALIDATION_FAILED')) notFound();
    throw err;
  }
  if (c.pendingOrderId) redirect(routes.checkout.order(c.pendingOrderId));

  const sourceParams = { listing: sp.listing, offer: sp.offer, auction: sp.auction, secondChance: sp.secondChance };
  const linkWith = (extra: Record<string, string | undefined>) => withQuery('/checkout/new', { ...sourceParams, address: c.selectedAddress?.id, quantity: sp.quantity, ...extra });
  const unitPrice = c.reservation?.unitPriceMinor ?? c.listing.unitPriceMinor;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader eyebrow="Protected checkout" title="Review and pay" description="Your payment is held by Thrift Market and only released to the seller after delivery is confirmed." />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card className="flex gap-4 p-4">
            <div className="h-24 w-20 flex-none overflow-hidden rounded-lg bg-sand">
              {c.listing.photoUrl && <Photo src={c.listing.photoUrl} alt={c.listing.title} className="h-full w-full object-cover" />}
            </div>
            <div className="min-w-0">
              <Link href={routes.item(c.listing.id)} className="line-clamp-2 font-semibold text-ink hover:underline">{c.listing.title}</Link>
              <p className="text-sm text-muted">
                from <Link href={routes.shop(c.listing.shopSlug)} className="underline">{c.listing.shopName}</Link>
              </p>
              <p className="mt-1 text-sm text-muted">{[c.listing.conditionLabel, c.listing.sizeLabel].filter(Boolean).join(' · ')}</p>
              <p className="mt-1 font-semibold">
                {formatNaira(unitPrice)}
                {c.reservation && c.reservation.source !== 'checkout' && <span className="ml-2 text-sm font-normal text-muted">agreed price</span>}
              </p>
            </div>
          </Card>

          {c.reservation && (
            <Alert tone="info" title="Reserved for you">
              This piece is held for you until <Countdown target={c.reservation.expiresAt} serverNow={c.serverNow} expiredText="the hold has ended" />. Complete payment before then.
            </Alert>
          )}

          {c.mode === 'listing' && c.listing.quantityMode === 'equivalent' && c.listing.quantityAvailable > 1 && (
            <CardSection title="Quantity">
              <form method="get" className="flex items-end gap-3">
                {Object.entries({ ...sourceParams, address: c.selectedAddress?.id }).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
                <label className="text-sm font-medium">
                  How many?
                  <select name="quantity" defaultValue={String(c.quantity)} className="mt-1 block min-h-11 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3">
                    {Array.from({ length: Math.min(c.listing.quantityAvailable, 10) }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <button className="min-h-11 rounded-[var(--radius-control)] border-2 border-primary px-4 font-semibold text-primary">Update</button>
              </form>
            </CardSection>
          )}

          <CardSection title="Deliver to" action={<Link href={withQuery(routes.addresses, { next: self })} className="text-sm font-semibold text-primary underline">Add an address</Link>}>
            {c.addresses.length === 0 ? (
              <EmptyState title="Add a delivery address" action={<ButtonLink href={withQuery(routes.addresses, { next: self })}>Add address</ButtonLink>}>
                Your address is private. The seller only sees it after you’ve paid.
              </EmptyState>
            ) : (
              <ul className="space-y-2" aria-label="Your addresses">
                {c.addresses.map((a) => {
                  const selected = a.id === c.selectedAddress?.id;
                  return (
                    <li key={a.id}>
                      <Link
                        href={linkWith({ address: a.id })}
                        aria-current={selected ? 'true' : undefined}
                        className={cx('block rounded-[var(--radius-card)] border-2 p-3 text-sm', selected ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:border-primary')}
                      >
                        <span className="font-semibold">{a.label}</span> · {a.recipientName}
                        <span className="block text-muted">{[a.line1, a.area, a.city, a.state].filter(Boolean).join(', ')}</span>
                        {selected && <span className="mt-1 block text-xs font-semibold text-primary">Selected</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardSection>

          {c.policies.length > 0 && (
            <CardSection title="Buyer protection and returns">
              <div className="space-y-3 text-sm text-muted">
                {c.policies.map((p) => (
                  <div key={p.title}>
                    <p className="font-semibold text-ink">{p.title}</p>
                    <p className="whitespace-pre-line">{p.body}</p>
                  </div>
                ))}
              </div>
            </CardSection>
          )}
        </div>

        <aside>
          <Card className="sticky top-4 p-4">
            {c.blocked ? (
              <Alert tone="warning" title="Checkout unavailable">{c.blocked}</Alert>
            ) : !c.selectedAddress ? (
              <p className="text-sm text-muted">Choose a delivery address to see delivery options and the total.</p>
            ) : c.options.length === 0 ? (
              <Alert tone="warning" title="No delivery to this address">This shop doesn’t deliver to {c.selectedAddress.city}, {c.selectedAddress.state}. Try another address.</Alert>
            ) : (
              <ActionForm action={startCheckoutAction} refreshOnSuccess={false}>
                <input type="hidden" name="idempotencyKey" value={randomUUID().replace(/-/g, '')} />
                <input type="hidden" name="addressId" value={c.selectedAddress.id} />
                {c.reservation && c.mode === 'reservation' ? (
                  <input type="hidden" name="reservationId" value={c.reservation.id} />
                ) : (
                  <>
                    <input type="hidden" name="listingId" value={c.listing.id} />
                    <input type="hidden" name="quantity" value={c.quantity} />
                  </>
                )}
                <fieldset>
                  <legend className="mb-2 font-semibold">Delivery</legend>
                  <div className="space-y-2">
                    {c.options.map((o, i) => (
                      <label key={o.method} className="flex cursor-pointer gap-3 rounded-[var(--radius-card)] border border-line p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                        <input type="radio" name="deliveryMethod" value={o.method} defaultChecked={i === 0} className="mt-1 accent-[var(--color-primary)]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex justify-between gap-2 font-semibold">
                            <span>{o.label}</span>
                            <span>{o.feeMinor === 0 ? 'Free' : formatNaira(o.feeMinor)}</span>
                          </span>
                          <span className="block text-muted">
                            Ships within {o.dispatchDays} day{o.dispatchDays === 1 ? '' : 's'} · arrives in {o.transitDaysMin}–{o.transitDaysMax} days
                          </span>
                          <span className="block text-xs text-muted">{o.trackingNote}</span>
                          <span className="mt-1 block text-xs">
                            Total <strong>{formatNaira(o.totals.totalMinor)}</strong>
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <dl className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
                  <div className="flex justify-between"><dt className="text-muted">Item{c.quantity > 1 ? `s (${c.quantity})` : ''}</dt><dd>{formatNaira(c.options[0]!.totals.itemsTotalMinor)}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">Delivery</dt><dd>shown per option above</dd></div>
                  {c.options[0]!.totals.buyerFeeMinor > 0 && (
                    <div className="flex justify-between"><dt className="text-muted">Buyer protection fee</dt><dd>{formatNaira(c.options[0]!.totals.buyerFeeMinor)}</dd></div>
                  )}
                </dl>
                {!c.reservation && (
                  <p className="mt-3 text-xs text-muted">When you continue, the piece is held for you for {c.holdMinutes} minutes while you pay.</p>
                )}
                <SubmitButton size="lg" className="mt-4 w-full" pendingText="Reserving…">Continue to payment</SubmitButton>
                <p className="mt-2 text-center text-xs text-muted">You’ll pay on the payment provider’s secure page.</p>
              </ActionForm>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
