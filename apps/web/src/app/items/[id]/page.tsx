import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getListingDetail, quoteDeliveryOptions, recordListingView, type ListingDetail } from '@thrift/application';
import { formatNaira, formatWat, isDomainError, isNigerianState, NIGERIAN_STATES, stateLabel, type DeliveryOption } from '@thrift/domain';
import { ItemGallery } from '@/components/catalogue/ItemGallery';
import { ShareCard } from '@/components/catalogue/ShareCard';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx } from '@/server/session';
import { saveItemAction } from './actions';

type Params = { params: Promise<{ id: string }>; searchParams: Promise<{ dest?: string }> };

async function load(id: string): Promise<ListingDetail | null> {
  try {
    return await getListingDetail(await getCtx(), id);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const item = await load((await params).id);
  if (!item) return { title: 'Item not found' };
  const price = item.priceMinor ? `${formatNaira(item.priceMinor)} · ` : '';
  return {
    title: item.title,
    description: `${price}${item.conditionLabel ?? ''}${item.size.label ? ` · size ${item.size.label}` : ''} · ${item.shop.name}, ${item.shop.city}`,
  };
}

async function destinationFor(item: ListingDetail, dest?: string): Promise<{ state: string; city: string; chosen: boolean }> {
  if (dest && isNigerianState(dest)) return { state: dest, city: '', chosen: true };
  try {
    const raw = (await cookies()).get('tm_loc')?.value;
    if (raw) {
      const loc = JSON.parse(raw) as { state?: string; city?: string };
      if (loc.state && isNigerianState(loc.state)) return { state: loc.state, city: loc.city ?? '', chosen: true };
    }
  } catch {
    // ignore malformed cookie
  }
  return { state: item.shop.state, city: item.shop.city, chosen: false };
}

export default async function ItemPage({ params, searchParams }: Params) {
  const { id } = await params;
  const { dest } = await searchParams;
  const item = await load(id);
  if (!item) notFound();
  const ctx = await getCtx();
  const h = await headers();
  const viewerKey = ctx.actor.kind === 'user' ? `u:${ctx.actor.userId}` : `a:${ctx.ip ?? ''}:${h.get('user-agent') ?? ''}`;
  await recordListingView(ctx.pool, { listingId: item.id, viewerKey, secret: ctx.config.appSecret, isOwner: item.isOwner }).catch(() => false);

  const destination = await destinationFor(item, dest);
  const options: DeliveryOption[] = await quoteDeliveryOptions(ctx.pool, { listingId: item.id, destination: { state: destination.state, city: destination.city } }).catch(() => []);
  const signedIn = ctx.actor.kind === 'user';
  const itemUrl = new URL(routes.item(item.id), services().config.baseUrl).toString();
  const canBuy = item.availability === 'available' && !item.isOwner && item.saleMode !== 'auction';

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 lg:py-10">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <Link href={routes.search()} className="hover:text-primary">Browse</Link> /{' '}
        <Link href={routes.search({ category: item.categorySlug })} className="hover:text-primary">{item.categoryName}</Link>
      </nav>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <ItemGallery photos={item.photos} title={item.title} />

        <div className="space-y-5">
          <div>
            <div className="mb-2 flex flex-wrap gap-2">
              {item.saleMode !== 'fixed' && <Badge tone={item.saleMode === 'auction' ? 'info' : 'primary'}>{item.saleModeLabel}</Badge>}
              {item.availability === 'reserved' && <Badge tone="warning">Reserved</Badge>}
              {item.availability === 'sold' && <Badge>Sold</Badge>}
              {item.availability === 'scheduled' && <Badge tone="info">Upcoming drop</Badge>}
              {['ended', 'removed'].includes(item.availability) && <Badge>No longer available</Badge>}
              {item.availability === 'paused' && <Badge>Shop paused</Badge>}
              {item.availability === 'draft' && <Badge>Draft — only you can see this</Badge>}
            </div>
            <h1 className="text-2xl font-bold leading-tight text-ink sm:text-3xl">{item.title}</h1>
            {item.priceMinor !== null && <p className="mt-2 text-3xl font-bold text-primary">{formatNaira(item.priceMinor)}</p>}
            {item.saleMode === 'auction' && item.auction && (
              <p className="mt-2 text-lg">
                <span className="text-muted">{item.auction.currentBidMinor ? 'Current bid ' : 'Opening price '}</span>
                <strong className="text-primary">{formatNaira(item.auction.currentBidMinor ?? item.auction.openingPriceMinor)}</strong>
              </p>
            )}
            <p className="mt-2 text-muted">
              {[item.size.label ? `Size ${item.size.label}${item.size.systemLabel ? ` (${item.size.systemLabel})` : ''}` : null, item.measurements.length > 0 ? 'measurements included' : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {item.quantityMode === 'equivalent' && item.availability === 'available' && (
              <p className="mt-1 text-sm text-muted">
                {item.quantityAvailable} identical {item.quantityAvailable === 1 ? 'unit' : 'units'} available
              </p>
            )}
          </div>

          {item.condition && (
            <Card className="p-4">
              <h2 className="font-semibold">{item.conditionLabel}</h2>
              <p className="text-sm text-muted">{item.conditionSummary}</p>
              {item.flawsDeclaration === 'none_known' && <p className="mt-2 text-sm">The seller confirms there are no known flaws.</p>}
              {item.flaws.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {item.flaws.map((f) => (
                    <li key={f.id}>
                      <span className="font-medium capitalize">{f.severity}:</span> {f.description}
                      {f.location ? ` (${f.location})` : ''}
                      {f.photoIndex !== null && (
                        <>
                          {' '}
                          — <a href={`#photo-${f.photoIndex + 1}`} className="font-semibold text-primary underline">close-up in photo {f.photoIndex + 1}</a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <div className="space-y-3">
            {item.isOwner ? (
              <ButtonLink href={routes.sell.listing(item.id)} className="w-full">Edit listing</ButtonLink>
            ) : item.saleMode === 'auction' && item.auction ? (
              <>
                <ButtonLink href={routes.auction(item.auction.id)} size="lg" className="w-full">View auction and bid</ButtonLink>
                <p className="text-sm text-muted">
                  Auction {item.auction.status === 'scheduled' ? `starts ${formatWat(item.auction.startsAt)}` : `ends ${formatWat(item.auction.endsAt)}`}. A bid is a commitment, not a payment.
                </p>
              </>
            ) : canBuy ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <ButtonLink href={signedIn ? routes.checkout.listing(item.id) : routes.auth.signIn(routes.checkout.listing(item.id))} size="lg">
                  Buy at listed price
                </ButtonLink>
                {item.saleMode === 'negotiable' && (
                  <ButtonLink href={signedIn ? routes.itemOffer(item.id) : routes.auth.signIn(routes.itemOffer(item.id))} variant="secondary" size="lg">
                    Make an offer
                  </ButtonLink>
                )}
              </div>
            ) : item.availability === 'reserved' ? (
              <Alert tone="warning" title="Reserved">Another buyer is checking out. If their payment doesn’t complete, the piece becomes available again.</Alert>
            ) : item.availability === 'scheduled' && item.dropAt ? (
              <Alert tone="info" title="Upcoming drop">Goes on sale {formatWat(item.dropAt)}. Follow the shop to hear when it drops.</Alert>
            ) : item.availability === 'paused' ? (
              <Alert tone="info">This shop is paused and not taking new orders right now.</Alert>
            ) : item.availability === 'sold' ? (
              <Alert tone="info">This piece has sold.</Alert>
            ) : null}
            {!item.isOwner && (
              <div className="flex flex-wrap gap-2">
                {signedIn ? (
                  <ActionForm action={saveItemAction} showSuccess={false}>
                    <input type="hidden" name="listingId" value={item.id} />
                    <input type="hidden" name="saved" value={item.saved ? 'false' : 'true'} />
                    <SubmitButton variant="ghost" size="sm" pendingText="Saving…">
                      {item.saved ? '♥ Saved' : '♡ Save'}
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <ButtonLink href={routes.auth.signIn(routes.item(item.id))} variant="ghost" size="sm">♡ Save</ButtonLink>
                )}
                {['available', 'reserved'].includes(item.availability) && (
                  <ButtonLink href={signedIn ? routes.startConversation(item.id) : routes.auth.signIn(routes.startConversation(item.id))} variant="ghost" size="sm">
                    Message seller
                  </ButtonLink>
                )}
              </div>
            )}
          </div>

          <Card className="p-4">
            <h2 className="font-semibold">Delivery to {destination.chosen ? stateLabel(destination.state) : `${stateLabel(destination.state)} (seller’s state)`}</h2>
            {options.length === 0 ? (
              <p className="mt-1 text-sm text-error">This piece can’t currently be delivered to {stateLabel(destination.state)}. Try another state below.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {options.map((o) => (
                  <li key={o.method} className="flex justify-between gap-3">
                    <span>
                      <span className="font-medium">{o.label}</span>
                      <span className="block text-muted">
                        Dispatched within {o.dispatchDays} {o.dispatchDays === 1 ? 'day' : 'days'}
                        {o.transitDaysMax > 0 ? `, then ${o.transitDaysMin}–${o.transitDaysMax} days in transit` : ''}
                      </span>
                    </span>
                    <span className="font-semibold">{o.feeMinor === 0 ? 'Free' : formatNaira(o.feeMinor)}</span>
                  </li>
                ))}
              </ul>
            )}
            <form method="get" className="mt-3 flex items-end gap-2">
              <label className="flex-1 text-sm">
                <span className="mb-1 block font-medium">Check another state</span>
                <select name="dest" defaultValue={destination.state} className="w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2">
                  {NIGERIAN_STATES.map((s) => (
                    <option key={s} value={s}>{stateLabel(s)}</option>
                  ))}
                </select>
              </label>
              <button type="submit" className="min-h-11 rounded-[var(--radius-control)] border-2 border-primary px-3 font-semibold text-primary">Check</button>
            </form>
            <p className="mt-2 text-xs text-muted">Final delivery cost is confirmed for your exact address at checkout, before you pay.</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Link href={routes.shop(item.shop.slug)} className="text-lg font-semibold text-primary hover:underline">{item.shop.name}</Link>
                <p className="text-sm text-muted">{[item.shop.area, item.shop.city, item.shop.stateLabel].filter(Boolean).join(', ')}</p>
              </div>
              {item.shop.verification.verified && <Badge tone="success">{item.shop.verification.label}</Badge>}
            </div>
            <p className="mt-2 text-sm">
              <span className="font-medium">{item.shop.reputation.tierLabel}</span> · {item.shop.reputation.sampleText}
            </p>
            <p className="mt-1 text-xs text-muted">{item.shop.verification.explanation}</p>
            <p className="mt-1 text-xs text-muted">{item.shop.coverageSummary}</p>
          </Card>

          {(item.description || item.measurements.length > 0 || item.attributes.length > 0 || item.brand || item.colour || item.material) && (
            <section aria-labelledby="details-h" className="space-y-3">
              <h2 id="details-h" className="text-lg font-semibold">Details</h2>
              {item.description && <p className="whitespace-pre-line text-[15px] leading-7">{item.description}</p>}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {item.brand && (<><dt className="text-muted">Brand</dt><dd>{item.brand}</dd></>)}
                {item.colour && (<><dt className="text-muted">Colour</dt><dd>{item.colour}</dd></>)}
                {item.material && (<><dt className="text-muted">Material</dt><dd>{item.material}</dd></>)}
                {item.measurements.map((m) => (
                  <Fragment key={`m-${m.key}`}><dt className="text-muted">{m.label}</dt><dd>{m.valueCm} cm</dd></Fragment>
                ))}
                {item.attributes.map((a) => (
                  <Fragment key={`a-${a.key}`}><dt className="text-muted">{a.label}</dt><dd>{a.value}</dd></Fragment>
                ))}
              </dl>
              {item.brand && <p className="text-xs text-muted">Brand names are as stated by the seller; authenticity is not verified by the platform.</p>}
            </section>
          )}

          <ShareCard url={itemUrl} title="this piece" hint="Paste the link in your WhatsApp status or Instagram bio, or print the QR code for your stall." />
          {!item.isOwner && (
            <p className="text-sm">
              <Link href={routes.report('listing', item.id)} className="text-muted underline hover:text-error">Report this listing</Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
