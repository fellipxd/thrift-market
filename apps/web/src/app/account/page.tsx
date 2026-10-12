import Link from 'next/link';
import { getAccount } from '@thrift/application';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { signOutAction } from '../(auth)/actions';

export const metadata = { title: 'Account' };

export default async function AccountPage() {
  const user = await requireUserPage(routes.account);
  const account = await getAccount(await getCtx());
  const links: { href: string; label: string; hint: string }[] = [
    { href: routes.orders, label: 'Orders', hint: 'Payments, delivery and receipts' },
    { href: routes.inbox, label: 'Inbox', hint: 'Conversations and offers' },
    { href: routes.saved, label: 'Saved items', hint: 'Pieces you are watching' },
    { href: routes.following, label: 'Shops you follow', hint: 'New drops from your favourite sellers' },
    { href: routes.notifications, label: 'Notifications', hint: 'Updates about your activity' },
    { href: routes.addresses, label: 'Delivery addresses', hint: 'Private until needed for an order' },
    { href: routes.notificationSettings, label: 'Notification preferences', hint: 'Choose drops, auctions and promotions' },
    { href: routes.security(), label: 'Two-step verification', hint: user.roles.length > 0 ? 'Required for staff tools' : 'Extra protection for your account' },
    { href: routes.sell.home, label: 'Seller workspace', hint: 'Your shop, listings and payouts' },
  ];
  if (user.roles.length > 0) links.push({ href: routes.admin.home, label: 'Operations console', hint: `Staff: ${user.roles.join(', ')}` });
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader title={`Hello, ${account.displayName.split(' ')[0]}`} description={account.email ?? account.phone ?? undefined} />
      {!account.contactVerified && (
        <Card className="mb-6 flex items-center justify-between gap-4 border-warning/40 bg-warning-soft p-4">
          <p className="text-sm text-ink">Verify your contact to message sellers, make offers, bid and check out.</p>
          <Link href={routes.auth.verify(routes.account)} className="whitespace-nowrap text-sm font-semibold text-primary underline">
            Verify now
          </Link>
        </Card>
      )}
      <div className="mb-4 flex gap-2">{account.contactVerified ? <Badge tone="success">Contact verified</Badge> : <Badge tone="warning">Contact not verified</Badge>}</div>
      <ul className="grid border-t border-ink sm:grid-cols-2 sm:gap-x-8">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="group block border-b border-line py-4 hover:bg-sand/60">
              <span className="font-semibold text-ink">{l.label}</span>
              <span className="mt-0.5 block text-sm text-muted">{l.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
      <form action={signOutAction} className="mt-8">
        <Button variant="secondary" type="submit">Sign out</Button>
      </form>
    </div>
  );
}
