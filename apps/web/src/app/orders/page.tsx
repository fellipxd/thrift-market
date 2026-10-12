import { buyerOrders } from '@thrift/application';
import { OrderList } from '@/components/orders/OrderList';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';

export const metadata = { title: 'My orders' };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  await requireUserPage(routes.orders);
  const { cursor } = await searchParams;
  const page = await buyerOrders(await getCtx(), { cursor });
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <PageHeader title="My orders" description="Payment, delivery and refunds for everything you’ve bought." />
      {page.items.length === 0 ? (
        <EmptyState title="No orders yet" action={<ButtonLink href={routes.search()}>Start browsing</ButtonLink>}>
          When you buy something, you’ll follow its payment and delivery here.
        </EmptyState>
      ) : (
        <>
          <OrderList items={page.items} hrefFor={routes.order} counterpartLabel="from" />
          {page.nextCursor && (
            <div className="mt-6 flex justify-center">
              <ButtonLink href={withQuery(routes.orders, { cursor: page.nextCursor })} variant="secondary">Older orders</ButtonLink>
            </div>
          )}
        </>
      )}
    </div>
  );
}
