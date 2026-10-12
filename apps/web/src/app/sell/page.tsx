import Link from 'next/link';
import { getSellerOverview } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { ChecklistCard } from '@/components/catalogue/ChecklistCard';
import { ListingStatusBadge } from '@/components/catalogue/ListingStatusBadge';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card, StatTile } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { publishShopAction } from './settings/actions';

export const metadata = { title: 'Seller overview' };

function actionHref(a: { nextActionKind: string; listingId: string; auctionId: string | null; orderId: string | null }): string {
  switch (a.nextActionKind) {
    case 'review_offers':
      return routes.sell.offers;
    case 'view_auction':
      return a.auctionId ? routes.auction(a.auctionId) : routes.sell.auctions;
    case 'ship_order':
      return a.orderId ? routes.sell.order(a.orderId) : routes.sell.orders;
    case 'share':
      return routes.item(a.listingId);
    default:
      return routes.sell.listing(a.listingId);
  }
}

export default async function SellHome() {
  await requireUserPage(routes.sell.home);
  const overview = await getSellerOverview(await getCtx());
  if (!overview) {
    return (
      <div className="max-w-2xl">
        <PageHeader eyebrow="Sell" title="Turn your rail into a shop" description="One link for your whole catalogue, clear condition details, protected checkout and delivery tracking." />
        <EmptyState title="You don’t have a shop yet" action={<ButtonLink href={routes.sell.onboarding}>Open a shop</ButtonLink>}>
          It takes a few minutes. You’ll add your shop details, where you deliver and a payout account.
        </EmptyState>
      </div>
    );
  }
  const { shop, checklist, counts } = overview;
  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description={shop.name} actions={<ButtonLink href={routes.sell.newListing}>Add an item</ButtonLink>} />
      {shop.status === 'draft' && (
        <Card className="space-y-3 p-4">
          <p className="font-semibold">Your shop isn’t open yet.</p>
          {checklist.readyToPublish ? (
            <ActionForm action={publishShopAction}>
              <SubmitButton pendingText="Opening…">Open my shop</SubmitButton>
            </ActionForm>
          ) : (
            <p className="text-sm text-muted">Finish the required steps below, then open your shop.</p>
          )}
        </Card>
      )}
      {shop.status === 'paused' && <Alert tone="info" title="Your shop is paused">Listings are hidden from buyers. Resume it in Shop settings.</Alert>}
      {shop.status === 'suspended' && <Alert tone="error" title="Your shop is suspended">New sales are blocked. Existing orders must still be fulfilled. Contact support for details.</Alert>}
      {!checklist.complete && <ChecklistCard checklist={checklist} />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Active pieces" value={counts.active + counts.reserved} hint={counts.scheduled ? `${counts.scheduled} scheduled` : undefined} />
        <StatTile label="Orders to ship" value={overview.ordersToShip} />
        <StatTile label="Offers to review" value={overview.pendingOffers} />
        <StatTile
          label="Pending payout"
          value={formatNaira(overview.payouts.heldMinor + overview.payouts.eligibleMinor)}
          hint={`${formatNaira(overview.payouts.eligibleMinor)} ready to release`}
        />
      </div>
      <section aria-labelledby="next-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="next-h" className="text-lg font-semibold">Inventory and next actions</h2>
          <Link href={routes.sell.listings} className="text-sm font-semibold text-primary underline">All listings</Link>
        </div>
        {overview.nextActions.length === 0 ? (
          <EmptyState title="Nothing needs you right now" action={<ButtonLink href={routes.sell.newListing}>List a piece</ButtonLink>}>
            New offers, orders to ship and drafts will appear here.
          </EmptyState>
        ) : (
          <>
            <table className="hidden w-full overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface text-left text-sm md:table">
              <thead className="bg-primary-soft text-primary">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Sale mode</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Next action</th>
                </tr>
              </thead>
              <tbody>
                {overview.nextActions.map((a) => (
                  <tr key={`${a.listingId}-${a.nextActionKind}`} className="border-t border-line">
                    <td className="px-4 py-3">
                      <Link href={routes.sell.listing(a.listingId)} className="font-medium hover:underline">{a.title}</Link>
                      <span className="block text-xs text-muted">{a.detail}</span>
                    </td>
                    <td className="px-4 py-3 capitalize">{a.saleMode}</td>
                    <td className="px-4 py-3"><ListingStatusBadge status={a.status} label={a.statusLabel} /></td>
                    <td className="px-4 py-3">
                      {a.nextActionKind === 'none' ? <span className="text-muted">—</span> : <Link href={actionHref(a)} className="font-semibold text-primary underline">{a.nextAction}</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="space-y-2 md:hidden">
              {overview.nextActions.map((a) => (
                <li key={`${a.listingId}-${a.nextActionKind}-m`} className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={routes.sell.listing(a.listingId)} className="font-medium">{a.title}</Link>
                    <ListingStatusBadge status={a.status} label={a.statusLabel} />
                  </div>
                  <p className="text-xs text-muted">{a.detail}</p>
                  {a.nextActionKind !== 'none' && <Link href={actionHref(a)} className="mt-1 inline-block text-sm font-semibold text-primary underline">{a.nextAction}</Link>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <p className="text-xs text-muted">Gross sales, refunds, fees, pending payout and settled payout are reported separately on the Payouts page.</p>
    </div>
  );
}
