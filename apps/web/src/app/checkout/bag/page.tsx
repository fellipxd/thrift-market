import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getBagCheckoutContext, type BagCheckoutContext } from '@thrift/application';
import { formatNaira, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardSection } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Photo } from '@/components/ui/Photo';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireVerifiedPage } from '@/server/session';
import { startBagCheckoutAction } from '../actions';

export const metadata = { title: 'Checkout' };

/**
 * Same-seller bag checkout: the shop's available bag pieces at today's prices, one parcel and delivery fee, one
 * total. Continuing holds every piece together or none; the buyer confirms the exact pieces and prices shown here.
 */
export default async function BagCheckoutPage({ searchParams }: { searchParams: Promise<{ shop?: string; address?: string }> }) {
  const sp = await searchParams;
  const self = withQuery('/checkout/bag', sp);
  await requireVerifiedPage(self);
  let c: BagCheckoutContext;
  try {
    c = await getBagCheckoutContext(await getCtx(), sp);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  const several = c.items.length > 1 || c.items.some((i) => i.quantity > 1);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader
        eyebrow="Checkout"
        title="Review and pay"
        description={`Everything from ${c.shop.name} in one order and one parcel. Your order is confirmed only after the payment provider verifies your payment.`}
      />
      {c.pendingOrderId && (
        <div className="mb-6">
          <Alert tone="info" title="You have an unpaid order from this shop">
            Some pieces are already held for you. <Link href={routes.checkout.order(c.pendingOrderId)} className="underline">Finish paying for that order</Link> — they aren’t included again here.
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
        <div className="space-y-6 lg:col-start-1">
          <CardSection title={`From ${c.shop.name}`} action={<Link href={routes.bag} className="text-sm font-semibold text-primary underline">Edit bag</Link>}>
            {c.items.length === 0 ? (
              <p className="text-sm text-muted">None of your bag pieces from this shop can be bought right now.</p>
            ) : (
              <ul className="divide-y divide-line" aria-label="Pieces in this order">
                {c.items.map((it) => (
                  <li key={it.listingId} className="flex gap-4 py-3 first:pt-0 last:pb-0">
                    <div className="h-24 w-20 flex-none overflow-hidden bg-sand">{it.photoUrl && <Photo src={it.photoUrl} alt={it.title} className="h-full w-full object-cover" />}</div>
                    <div className="min-w-0 flex-1">
                      <Link href={routes.item(it.listingId)} className="line-clamp-2 font-semibold text-ink hover:underline">
                        {it.title}
                      </Link>
                      <p className="text-sm text-muted">{[it.conditionLabel, it.sizeLabel, it.quantity > 1 ? `Qty ${it.quantity}` : null].filter(Boolean).join(' · ')}</p>
                      {it.priceChanged && <p className="text-sm text-muted">Price changed since you added it — this is today’s price.</p>}
                    </div>
                    <p className="shrink-0 font-semibold tabular-nums">{formatNaira((it.unitPriceMinor ?? 0) * it.quantity)}</p>
                  </li>
                ))}
              </ul>
            )}
            {c.excluded.length > 0 && (
              <p className="mt-4 border-t border-line pt-3 text-sm text-muted">
                Not included (still in your bag): {c.excluded.map((i) => i.title).join(', ')}.
              </p>
            )}
          </CardSection>

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
                        href={routes.checkout.bag(c.shop.id, a.id)}
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
        </div>

        <aside className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <Card className="sticky top-4 p-4">
            {c.blocked ? (
              <Alert tone="warning" title="Checkout unavailable">{c.blocked}</Alert>
            ) : !c.selectedAddress ? (
              <p className="text-sm text-muted">Choose a delivery address to see delivery options and the total.</p>
            ) : c.options.length === 0 ? (
              <Alert tone="warning" title="No delivery to this address">
                These pieces can’t be sent together to {c.selectedAddress.city}, {c.selectedAddress.state}. Try another address, or remove a piece from your bag.
              </Alert>
            ) : (
              <ActionForm action={startBagCheckoutAction} refreshOnSuccess={false}>
                <input type="hidden" name="idempotencyKey" value={randomUUID().replace(/-/g, '')} />
                <input type="hidden" name="shopId" value={c.shop.id} />
                <input type="hidden" name="addressId" value={c.selectedAddress.id} />
                {c.items.map((it) => (
                  <input key={it.listingId} type="hidden" name="item" value={`${it.listingId}:${it.quantity}:${it.unitPriceMinor}`} />
                ))}
                <fieldset>
                  <legend className="mb-2 font-semibold">Delivery — one parcel</legend>
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
                  <div className="flex justify-between">
                    <dt className="text-muted">
                      {c.items.length} {c.items.length === 1 ? 'piece' : 'pieces'}
                    </dt>
                    <dd>{formatNaira(c.options[0]!.totals.itemsTotalMinor)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Delivery</dt>
                    <dd>shown per option above</dd>
                  </div>
                  {c.options[0]!.totals.buyerFeeMinor > 0 && (
                    <div className="flex justify-between">
                      <dt className="text-muted">Buyer fee</dt>
                      <dd>{formatNaira(c.options[0]!.totals.buyerFeeMinor)}</dd>
                    </div>
                  )}
                </dl>
                <p className="mt-3 text-xs text-muted">
                  When you continue, {several ? 'every piece is held for you together' : 'the piece is held for you'} for {c.holdMinutes} minutes while you pay. If any piece has just sold or changed price, nothing is held and we’ll show you what changed.
                </p>
                {c.policies.length > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    Continuing means you accept the <a href="#purchase-terms" className="text-primary underline">terms for this purchase</a>.
                  </p>
                )}
                <SubmitButton size="lg" className="mt-4 w-full" pendingText="Reserving…">
                  Continue to payment
                </SubmitButton>
                <p className="mt-2 text-center text-xs text-muted">You’ll pay on the payment provider’s secure page.</p>
              </ActionForm>
            )}
          </Card>
        </aside>

        <div id="purchase-terms" className="lg:col-start-1">
          {c.policies.length > 0 && (
            <CardSection title="Terms for this purchase">
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
      </div>
    </div>
  );
}
