import { findOwnShop } from '@thrift/application';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { requireUserPage } from '@/server/session';

export default async function SellLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUserPage(routes.sell.home);
  const shop = await findOwnShop(services().pool, user.userId);
  const items = shop
    ? [
        { href: routes.sell.home, label: 'Overview' },
        { href: routes.sell.listings, label: 'Listings' },
        { href: routes.sell.batches, label: 'Batches & drops' },
        { href: routes.sell.offers, label: 'Offers & chat' },
        { href: routes.sell.auctions, label: 'Auctions' },
        { href: routes.sell.orders, label: 'Orders' },
        { href: routes.sell.payouts, label: 'Payouts' },
        { href: routes.sell.promotions, label: 'Promotions' },
        { href: routes.sell.insights, label: 'Insights' },
        { href: routes.sell.reviews, label: 'Reviews' },
        { href: routes.sell.verification, label: 'Verification' },
        { href: routes.sell.settings, label: 'Shop settings' },
      ]
    : [{ href: routes.sell.home, label: 'Start selling' }];
  return (
    <WorkspaceShell title="My shop" subtitle={shop?.name ?? 'Not set up yet'} items={items}>
      {children}
    </WorkspaceShell>
  );
}
