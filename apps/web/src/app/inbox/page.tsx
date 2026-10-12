import Link from 'next/link';
import { findOwnShop, listConversations } from '@thrift/application';
import { ConversationList } from '@/components/messaging/ConversationList';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';

export const metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ tab?: string; cursor?: string }> }) {
  const user = await requireUserPage(routes.inbox);
  const sp = await searchParams;
  const shop = await findOwnShop(services().pool, user.userId);
  const tab = sp.tab === 'selling' && shop ? 'selling' : 'buying';
  const page = await listConversations(await getCtx(), { as: tab === 'selling' ? 'seller' : 'buyer', cursor: sp.cursor });
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <PageHeader title="Inbox" description="Questions, photos and offers about items — all in one place." />
      {shop && (
        <nav aria-label="Inbox" className="mb-4 flex gap-1">
          {(['buying', 'selling'] as const).map((t) => (
            <Link
              key={t}
              href={withQuery(routes.inbox, { tab: t === 'buying' ? undefined : t })}
              aria-current={tab === t ? 'page' : undefined}
              className={cx('inline-flex min-h-10 items-center rounded-lg px-4 text-sm font-semibold', tab === t ? 'bg-primary text-white' : 'bg-surface text-ink')}
            >
              {t === 'buying' ? 'Buying' : `Selling · ${shop.name}`}
            </Link>
          ))}
        </nav>
      )}
      {page.items.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          action={tab === 'buying' ? <ButtonLink href={routes.search()}>Browse items</ButtonLink> : <ButtonLink href={routes.sell.listings}>View your listings</ButtonLink>}
        >
          {tab === 'buying' ? 'Message a seller from any item page to ask about size, condition or delivery.' : 'When buyers message you about your items, the conversations appear here.'}
        </EmptyState>
      ) : (
        <>
          <ConversationList items={page.items} />
          {page.nextCursor && (
            <div className="mt-6 flex justify-center">
              <ButtonLink href={withQuery(routes.inbox, { tab: tab === 'selling' ? 'selling' : undefined, cursor: page.nextCursor })} variant="secondary">
                Older conversations
              </ButtonLink>
            </div>
          )}
        </>
      )}
    </div>
  );
}
