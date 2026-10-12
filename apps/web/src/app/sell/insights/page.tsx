import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, INSIGHT_PERIODS, sellerInsights } from '@thrift/application';
import { formatNaira, formatWat, formatWatDate } from '@thrift/domain';
import { CardSection, StatTile } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';

export const metadata = { title: 'Insights' };
export const dynamic = 'force-dynamic';

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await requireUserPage(routes.sell.insights);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const sp = await searchParams;
  const ins = await sellerInsights(await getCtx(), Number(sp.days) || 30);
  const maxViews = Math.max(1, ...ins.daily.map((d) => d.views));
  return (
    <div className="space-y-6">
      <PageHeader title="Insights" description={`How your shop did since ${formatWatDate(ins.since)}. Views count each shopper once a day and leave out your own visits. Updated ${formatWat(ins.generatedAt)}.`} />
      <nav aria-label="Period" className="flex gap-2">
        {INSIGHT_PERIODS.map((d) => (
          <Link
            key={d}
            href={withQuery(routes.sell.insights, { days: d === 30 ? undefined : d })}
            aria-current={ins.periodDays === d ? 'page' : undefined}
            className={cx('rounded-sm border px-3 py-1 text-sm', ins.periodDays === d ? 'border-primary bg-primary text-white' : 'border-line-strong bg-surface')}
          >
            Last {d} days
          </Link>
        ))}
      </nav>

      <section aria-label="Engagement" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Item views" value={ins.engagement.views} />
        <StatTile label="Saves" value={ins.engagement.saves} />
        <StatTile label="Messages started" value={ins.engagement.messages} />
        <StatTile label="Offers received" value={ins.engagement.offers} />
      </section>

      <CardSection title="Sales">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Paid orders" value={ins.sales.paidOrders} hint={`Views → orders: ${pct(ins.sales.conversionPct)}`} />
          <StatTile label="Items sold" value={ins.sales.itemsSold} />
          <StatTile label="Item sales" value={formatNaira(ins.sales.grossMinor)} hint="Item prices on paid orders" />
          <StatTile label="Refunds" value={formatNaira(ins.sales.refundsMinor)} hint="Confirmed in this period" />
          <StatTile label="Cancelled by you" value={ins.sales.sellerCancellations} hint="Counts towards reputation" />
        </div>
        <p className="mt-2 text-xs text-muted">
          Fees, pending and paid-out amounts are on <Link href={routes.sell.payouts} className="underline">Payouts</Link>.
        </p>
      </CardSection>

      <div className="grid gap-4 lg:grid-cols-3">
        <CardSection title="Offers">
          <dl className="space-y-1 text-sm">
            <Row label="Received" value={ins.offers.received} />
            <Row label="Accepted" value={ins.offers.accepted} />
            <Row label="Countered" value={ins.offers.countered} />
            <Row label="Declined" value={ins.offers.declined} />
            <Row label="Expired without a reply" value={ins.offers.expired} />
            <Row label="Answered in time" value={pct(ins.offers.answeredPct)} />
          </dl>
        </CardSection>
        <CardSection title="Auctions">
          <dl className="space-y-1 text-sm">
            <Row label="Ended" value={ins.auctions.ended} />
            <Row label="Ended with bids" value={ins.auctions.withBids} />
            <Row label="Paid by the winner" value={ins.auctions.paid} />
            <Row label="Bids" value={ins.auctions.bids} />
            <Row label="Bidders" value={ins.auctions.bidders} />
          </dl>
        </CardSection>
        <CardSection title="Dispatch and stock">
          <dl className="space-y-1 text-sm">
            <Row label="Orders dispatched" value={ins.dispatch.dispatched} />
            <Row label="Dispatched late" value={ins.dispatch.late} />
            <Row label="On time" value={pct(ins.dispatch.onTimePct)} />
            <Row label="Items for sale" value={ins.stock.active} />
            <Row label="Published but out of stock" value={ins.stock.outOfStock} />
            <Row label="Reserved right now" value={ins.stock.reserved} />
            <Row label="Drafts" value={ins.stock.drafts} />
          </dl>
        </CardSection>
      </div>

      <CardSection title="Views by day">
        <ol className="flex h-32 items-end gap-[2px]" aria-label="Daily item views">
          {ins.daily.map((d) => (
            <li key={d.day} className="flex-1" title={`${d.day}: ${d.views} views, ${d.saves} saves`}>
              <span className="sr-only">
                {d.day}: {d.views} views
              </span>
              <span aria-hidden="true" className="block rounded-t bg-primary/70" style={{ height: `${Math.max(2, Math.round((d.views / maxViews) * 120))}px` }} />
            </li>
          ))}
        </ol>
      </CardSection>

      <CardSection title="Top items">
        {ins.topListings.length === 0 ? (
          <EmptyState title="No published items yet">Once your items are live, you’ll see which ones shoppers look at most.</EmptyState>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr>
                  <th className="py-2 font-semibold">Item</th>
                  <th className="py-2 font-semibold">Views</th>
                  <th className="py-2 font-semibold">Saves</th>
                  <th className="py-2 font-semibold">Messages</th>
                  <th className="py-2 font-semibold">Offers</th>
                  <th className="py-2 font-semibold">Sold</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {ins.topListings.map((l) => (
                  <tr key={l.id}>
                    <td className="py-2">
                      <Link href={routes.sell.listing(l.id)} className="text-primary underline">
                        {l.title}
                      </Link>
                      {l.status !== 'active' && <span className="ml-1 text-xs text-muted">({l.status})</span>}
                    </td>
                    <td className="py-2">{l.views}</td>
                    <td className="py-2">{l.saves}</td>
                    <td className="py-2">{l.messages}</td>
                    <td className="py-2">{l.offers}</td>
                    <td className="py-2">{l.sold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardSection>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
