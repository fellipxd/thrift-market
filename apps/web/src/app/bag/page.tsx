import Link from 'next/link';
import { getBag, type BagItem, type BagItemState } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Photo } from '@/components/ui/Photo';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { removeFromBagAction, setBagQuantityAction } from './actions';

export const metadata = { title: 'Bag' };

const STATE_NOTE: Record<Exclude<BagItemState, 'available'>, string> = {
  held_for_you: 'Held for you in an unpaid order',
  reserved: 'On hold for another buyer — it may come back',
  sold: 'Sold',
  unavailable: 'Not for sale right now',
};

function BagRow({ item }: { item: BagItem }) {
  const muted = item.state !== 'available' && item.state !== 'held_for_you';
  const showQty = item.quantityMode === 'equivalent' && item.state === 'available' && item.quantityAvailable > 1;
  return (
    <li className="grid grid-cols-[4.5rem_1fr] gap-4 py-4 sm:grid-cols-[5rem_1fr_auto]" data-testid="bag-item">
      <Link href={routes.item(item.listingId)} className={`block aspect-[4/5] overflow-hidden bg-sand ${muted ? 'opacity-60' : ''}`}>
        {item.photoUrl && <Photo src={item.photoUrl} alt={item.title} className="h-full w-full" />}
      </Link>
      <div className="min-w-0">
        <Link href={routes.item(item.listingId)} className="font-serif text-lg leading-snug text-ink hover:underline">
          {item.title}
        </Link>
        <p className="text-sm text-muted">{[item.conditionLabel, item.sizeLabel].filter(Boolean).join(' · ')}</p>
        {item.state !== 'available' && (
          <p className="label-caps mt-1 text-accent">
            {STATE_NOTE[item.state]}
            {item.state === 'held_for_you' && item.pendingOrderId && (
              <>
                {' '}
                · <Link href={routes.checkout.order(item.pendingOrderId)} className="underline underline-offset-4">Finish paying</Link>
              </>
            )}
          </p>
        )}
        {item.priceChanged && item.addedPriceMinor !== null && item.unitPriceMinor !== null && (
          <p className="mt-1 text-sm text-muted">
            Price changed from <span className="line-through">{formatNaira(item.addedPriceMinor)}</span> since you added it.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          {showQty && (
            <ActionForm action={setBagQuantityAction} showSuccess={false} className="flex items-center gap-2">
              <input type="hidden" name="listingId" value={item.listingId} />
              <label className="text-sm text-muted" htmlFor={`qty-${item.listingId}`}>
                Qty
              </label>
              <select
                id={`qty-${item.listingId}`}
                name="quantity"
                defaultValue={String(item.quantity)}
                className="min-h-11 border border-line-strong bg-surface px-2 text-sm"
              >
                {Array.from({ length: Math.min(item.quantityAvailable, 10) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <SubmitButton variant="ghost" size="sm" pendingText="Updating…">
                Update
              </SubmitButton>
            </ActionForm>
          )}
          <ActionForm action={removeFromBagAction} showSuccess={false}>
            <input type="hidden" name="listingId" value={item.listingId} />
            {/* Text-style action: pull it flush with the title when it starts the row. */}
            <SubmitButton variant="ghost" size="sm" pendingText="Removing…" className={showQty ? undefined : '-ml-3'}>
              Remove<span className="sr-only"> {item.title} from your bag</span>
            </SubmitButton>
          </ActionForm>
        </div>
      </div>
      <p className="col-start-2 text-sm font-semibold tabular-nums text-ink sm:col-start-3 sm:row-start-1 sm:text-right">
        {item.unitPriceMinor !== null ? formatNaira(item.unitPriceMinor * item.quantity) : '—'}
        {item.quantity > 1 && item.unitPriceMinor !== null && <span className="block font-normal text-muted">{formatNaira(item.unitPriceMinor)} each</span>}
      </p>
    </li>
  );
}

/**
 * The bag: pieces saved to buy, grouped by shop because one checkout pays one shop and ships one parcel. Nothing
 * here is held — the shop checkout holds every available piece together, or none.
 */
export default async function BagPage() {
  await requireUserPage(routes.bag);
  const bag = await getBag(await getCtx());
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 xl:px-12">
      <PageHeader
        title="Bag"
        description="Your bag doesn’t hold pieces — anyone can buy them until you pay. Each shop is a separate checkout: its pieces are held together while you pay and ship as one parcel."
      />
      {bag.groups.length === 0 ? (
        <EmptyState title="Your bag is empty" action={<ButtonLink href={routes.search()}>Start browsing</ButtonLink>}>
          Add pieces with “Add to bag” on any fixed-price item, then pay for a shop’s pieces together.
        </EmptyState>
      ) : (
        <div className="space-y-14">
          {bag.groups.map((g) => (
            <section key={g.shop.id} aria-labelledby={`bag-shop-${g.shop.id}`} className="grid gap-6 border-t border-ink pt-5 lg:grid-cols-12" data-testid="bag-shop">
              <div className="lg:col-span-8">
                <p className="label-caps text-muted">
                  {g.shop.city}, {g.shop.state}
                </p>
                <h2 id={`bag-shop-${g.shop.id}`} className="display mt-1 text-3xl text-ink">
                  <Link href={routes.shop(g.shop.slug)} className="hover:underline">
                    {g.shop.name}
                  </Link>
                </h2>
                <ul className="mt-4 divide-y divide-line border-y border-line">
                  {g.items.map((it) => (
                    <BagRow key={it.listingId} item={it} />
                  ))}
                </ul>
              </div>
              <aside className="lg:col-span-4 lg:pt-14">
                <dl className="flex items-baseline justify-between border-b border-line pb-3">
                  <dt className="label-caps text-muted">
                    {g.checkoutable.length} {g.checkoutable.length === 1 ? 'piece' : 'pieces'} available
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">{formatNaira(g.subtotalMinor)}</dd>
                </dl>
                <p className="mt-2 text-sm text-muted">Delivery is quoted once for the parcel at checkout.</p>
                {g.blocked ? (
                  <p className="mt-4 text-sm text-ink">{g.blocked}</p>
                ) : (
                  <ButtonLink href={routes.checkout.bag(g.shop.id)} size="lg" className="mt-4 w-full">
                    Check out from this shop
                  </ButtonLink>
                )}
                {g.checkoutable.length > 0 && g.checkoutable.length < g.items.length && !g.blocked && (
                  <p className="mt-2 text-xs text-muted">Pieces that aren’t available stay in your bag and aren’t included.</p>
                )}
              </aside>
            </section>
          ))}
          <p className="text-sm text-muted">
            {bag.count} of {bag.maxItems} pieces
          </p>
        </div>
      )}
    </div>
  );
}
