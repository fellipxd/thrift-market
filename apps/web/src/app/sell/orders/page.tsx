import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, sellerOrders, type SellerOrderFilter } from '@thrift/application';
import { OrderList } from '@/components/orders/OrderList';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';

export const metadata = { title: 'Orders' };

const TABS: { key: SellerOrderFilter; label: string }[] = [
  { key: 'to_ship', label: 'To ship' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'awaiting_payment', label: 'Awaiting payment' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

export default async function SellerOrdersPage({ searchParams }: { searchParams: Promise<{ filter?: string; cursor?: string }> }) {
  const user = await requireUserPage(routes.sell.orders);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const sp = await searchParams;
  const active = (TABS.find((t) => t.key === sp.filter)?.key ?? 'to_ship') as SellerOrderFilter;
  const page = await sellerOrders(await getCtx(), { filter: active, cursor: sp.cursor });
  return (
    <div className="space-y-5">
      <PageHeader title="Orders" description="Ship paid orders on time — your payout is released after delivery is confirmed." />
      <nav aria-label="Filter orders" className="-mx-1 overflow-x-auto">
        <ul className="flex gap-1 px-1 pb-1">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={withQuery(routes.sell.orders, { filter: t.key === 'to_ship' ? undefined : t.key })}
                aria-current={active === t.key ? 'page' : undefined}
                className={cx('inline-flex min-h-10 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold', active === t.key ? 'bg-primary text-white' : 'bg-surface text-ink')}
              >
                {t.label} <span className="ml-1 opacity-80">{page.counts[t.key]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {page.items.length === 0 ? (
        <EmptyState title={active === 'to_ship' ? 'Nothing to ship right now' : 'No orders here'}>
          {active === 'to_ship' ? 'New paid orders appear here with the date they need to be dispatched by.' : 'Try another tab.'}
        </EmptyState>
      ) : (
        <>
          <OrderList items={page.items} hrefFor={routes.sell.order} counterpartLabel="buyer" />
          {page.nextCursor && (
            <div className="flex justify-center">
              <ButtonLink href={withQuery(routes.sell.orders, { filter: sp.filter, cursor: page.nextCursor })} variant="secondary">Older orders</ButtonLink>
            </div>
          )}
        </>
      )}
    </div>
  );
}
