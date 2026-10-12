import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getShopStorefront, type ShopStorefront } from '@thrift/application';
import { formatWat, formatWatDate, isDomainError } from '@thrift/domain';
import { ShareCard } from '@/components/catalogue/ShareCard';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListingGrid } from '@/components/ui/ListingCard';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx } from '@/server/session';
import { followShopAction } from './actions';

type Params = { params: Promise<{ slug: string }>; searchParams: Promise<{ cursor?: string }> };

async function load(slug: string, cursor?: string): Promise<ShopStorefront | null> {
  try {
    return await getShopStorefront(await getCtx(), slug, cursor ?? null);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await load((await params).slug);
  if (!shop) return { title: 'Shop not found' };
  return { title: shop.name, description: `${shop.name} — secondhand fashion from ${shop.locationText}. ${shop.coverage.summary}` };
}

export default async function ShopPage({ params, searchParams }: Params) {
  const { slug } = await params;
  const { cursor } = await searchParams;
  const shop = await load(slug, cursor);
  if (!shop) notFound();
  const ctx = await getCtx();
  const signedIn = ctx.actor.kind === 'user';
  const shopUrl = new URL(routes.shop(shop.slug), services().config.baseUrl).toString();
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 xl:px-12 lg:py-10">
      <header className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="label-caps text-accent">Shop</p>
          <h1 className="display mt-2 text-[2.5rem] text-ink md:text-6xl">{shop.name}</h1>
          <p className="mt-1 text-muted">{shop.locationText}{shop.memberSince ? ` · selling since ${formatWatDate(shop.memberSince)}` : ''}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {shop.verification.verified ? <Badge tone="success">{shop.verification.label}</Badge> : <Badge>Identity not checked</Badge>}
            <Badge tone={shop.reputation.isNew ? 'neutral' : 'primary'}>{shop.reputation.tierLabel}</Badge>
            <Badge tone="neutral">{shop.followerCount} {shop.followerCount === 1 ? 'follower' : 'followers'}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {shop.isOwner ? (
            <ButtonLink href={routes.sell.settings} variant="secondary">Edit shop</ButtonLink>
          ) : signedIn ? (
            <ActionForm action={followShopAction} showSuccess={false}>
              <input type="hidden" name="shopId" value={shop.id} />
              <input type="hidden" name="follow" value={shop.viewerFollows ? 'false' : 'true'} />
              <SubmitButton variant={shop.viewerFollows ? 'secondary' : 'primary'} pendingText="Saving…">
                {shop.viewerFollows ? 'Following' : 'Follow shop'}
              </SubmitButton>
            </ActionForm>
          ) : (
            <ButtonLink href={routes.auth.signIn(routes.shop(shop.slug))}>Follow shop</ButtonLink>
          )}
        </div>
      </header>

      {shop.paused && (
        <Alert tone="info" className="mt-6" title="This shop is paused">
          {shop.pausedNotice ?? 'The seller isn’t taking new orders right now. Existing orders are still being fulfilled.'}
        </Alert>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-labelledby="catalogue-h">
          <h2 id="catalogue-h" className="mb-4 font-serif text-2xl">
            In the shop <span className="text-base font-normal text-muted">({shop.activeCount} available)</span>
          </h2>
          {shop.upcomingDrops.length > 0 && (
            <div className="mb-5 space-y-2">
              {shop.upcomingDrops.map((d) => (
                <Alert key={d.batchId} tone="info" title={`Upcoming drop: ${d.name}`}>
                  {d.pieces} {d.pieces === 1 ? 'piece goes' : 'pieces go'} on sale {formatWat(d.dropAt)}.
                </Alert>
              ))}
            </div>
          )}
          <ListingGrid items={shop.listings} emptyText="No pieces on sale right now. Follow the shop to hear about new drops." />
          {shop.nextCursor && (
            <div className="mt-8 flex justify-center">
              <ButtonLink href={withQuery(routes.shop(shop.slug), { cursor: shop.nextCursor })} variant="secondary">Load more</ButtonLink>
            </div>
          )}
        </section>

        <aside className="space-y-4">
          {shop.bio && (
            <Card className="p-4">
              <h2 className="font-serif text-xl">About</h2>
              <p className="mt-1 whitespace-pre-line text-sm">{shop.bio}</p>
            </Card>
          )}
          <Card className="p-4">
            <h2 className="font-serif text-xl">Service history</h2>
            <p className="mt-1 text-sm">{shop.reputation.sampleText}</p>
            <p className="mt-2 text-sm">
              <Link href={routes.shopReviews(shop.slug)} className="font-semibold text-primary underline">See reviews</Link>
            </p>
          </Card>
          <Card className="p-4">
            <h2 className="font-serif text-xl">Identity check</h2>
            <p className="mt-1 text-sm text-muted">{shop.verification.explanation}</p>
            {shop.verification.verifiedAt && <p className="mt-1 text-xs text-muted">Checked {formatWatDate(shop.verification.verifiedAt)}</p>}
          </Card>
          <Card className="p-4">
            <h2 className="font-serif text-xl">Delivery</h2>
            <p className="mt-1 text-sm">{shop.coverage.areaText}</p>
            <p className="text-sm text-muted">{shop.coverage.methodsText}</p>
            <p className="mt-1 text-sm text-muted">Usually dispatches within {shop.dispatchDays} {shop.dispatchDays === 1 ? 'day' : 'days'}.</p>
            {shop.pickupNote && <p className="mt-1 text-sm text-muted">Pickup: {shop.pickupNote}</p>}
          </Card>
          {shop.returnsPolicy && (
            <Card className="p-4">
              <h2 className="font-serif text-xl">Returns</h2>
              <p className="mt-1 whitespace-pre-line text-sm">{shop.returnsPolicy}</p>
            </Card>
          )}
          <ShareCard url={shopUrl} title="this shop" hint="Share your shop link with your WhatsApp, Instagram and Telegram followers." />
          {!shop.isOwner && (
            <p className="text-sm">
              <Link href={routes.report('shop', shop.id)} className="text-muted underline hover:text-error">Report this shop</Link>
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
