import Link from 'next/link';
import { followedShops } from '@thrift/application';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListingGrid } from '@/components/ui/ListingCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';

export const metadata = { title: 'Shops you follow' };

export default async function FollowingPage() {
  await requireUserPage(routes.following);
  const shops = await followedShops(await getCtx());
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 xl:px-12">
      <PageHeader title="Shops you follow" description="Their latest pieces, newest first. Choose which drop alerts you get in notification preferences." />
      {shops.length === 0 ? (
        <EmptyState title="You aren’t following any shops yet" action={<ButtonLink href={routes.nearby()}>Find shops</ButtonLink>}>
          Follow a shop from its page to see its new drops here.
        </EmptyState>
      ) : (
        <div className="space-y-10">
          {shops.map((s) => (
            <section key={s.id} aria-label={s.name}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Link href={routes.shop(s.slug)} className="text-lg font-semibold text-primary hover:underline">{s.name}</Link>
                  <p className="text-sm text-muted">{s.locationLabel} · {s.activeCount} on sale</p>
                </div>
                <div className="flex gap-2">
                  {!s.selling && <Badge>Not taking orders right now</Badge>}
                  {s.verified && <Badge tone="success">{s.verificationLabel ?? 'Identity checked'}</Badge>}
                </div>
              </div>
              <ListingGrid items={s.latest} emptyText="No pieces on sale right now." />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
