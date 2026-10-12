import Link from 'next/link';
import { bagCount, inboxUnreadCount } from '@thrift/application';
import { routes } from '@/lib/routes';
import { getCtx, getUser } from '@/server/session';
import { NotificationBell } from './NotificationBell';

/** Working masthead (“THRIFT” is the working descriptor; the final name is decision D01). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href={routes.home} className={className ?? 'display text-[1.75rem] tracking-[0.2em] text-ink md:text-[2.5rem]'} aria-label="Thrift Market home">
      THRIFT
    </Link>
  );
}

const navLink = 'label-caps inline-flex min-h-11 items-center px-2 text-ink underline-offset-[6px] hover:underline';

/** Editorial header: quiet tracked navigation around a serif masthead, with search always reachable below it. */
export async function SiteHeader() {
  const user = await getUser();
  const ctx = user ? await getCtx() : null;
  const unread = ctx ? await inboxUnreadCount(ctx).catch(() => 0) : 0;
  const inBag = ctx ? await bagCount(ctx).catch(() => 0) : 0;
  const bagLabel = inBag > 0 ? `Bag, ${inBag} ${inBag === 1 ? 'piece' : 'pieces'}` : 'Bag';
  return (
    <header className="border-b border-ink bg-canvas">
      <div className="mx-auto max-w-[1280px] px-4 md:px-8 xl:px-12">
        <div className="grid grid-cols-[1fr_auto] items-center gap-3 py-3 md:grid-cols-[1fr_auto_1fr] md:py-4">
          <nav aria-label="Discover" className="hidden items-center gap-2 md:flex">
            <Link href={routes.search()} className={navLink}>
              Discover
            </Link>
            <Link href={routes.nearby()} className={navLink}>
              Shops
            </Link>
            <Link href={routes.auctions} className={navLink}>
              Auctions
            </Link>
          </nav>
          <div className="md:justify-self-center">
            <Wordmark />
          </div>
          <nav aria-label="Main" className="hidden items-center justify-end gap-2 md:flex">
            <Link href={routes.saved} className={navLink}>
              Saved
            </Link>
            {user && (
              <Link href={routes.bag} className={navLink} aria-label={bagLabel}>
                Bag{inBag > 0 && <span className="ml-1 tabular-nums">({inBag})</span>}
              </Link>
            )}
            <Link href={routes.inbox} className={navLink}>
              Inbox
              {unread > 0 && (
                <span className="ml-1.5 bg-accent px-1.5 py-0.5 text-[11px] tracking-normal text-white" aria-label={`${unread} unread`}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </Link>
            <Link href={routes.sell.home} className={navLink}>
              Sell
            </Link>
            {user && <NotificationBell className={navLink} />}
            {user ? (
              <Link href={routes.account} className={`${navLink} border-b border-ink`}>
                {user.displayName.split(' ')[0]}
              </Link>
            ) : (
              <Link href={routes.auth.signIn()} className="label-caps ml-2 inline-flex min-h-11 items-center bg-primary px-4 text-white hover:bg-primary-hover">
                Sign in
              </Link>
            )}
          </nav>
          <div className="flex items-center justify-end gap-1 md:hidden">
            {user ? (
              <>
                <Link href={routes.bag} className="label-caps inline-flex min-h-11 items-center px-2 text-ink" aria-label={bagLabel}>
                  Bag{inBag > 0 && <span className="ml-1 tabular-nums">({inBag})</span>}
                </Link>
                <NotificationBell className="label-caps inline-flex min-h-11 items-center px-2 text-ink" />
              </>
            ) : (
              <Link href={routes.auth.signIn()} className="label-caps inline-flex min-h-11 items-center bg-primary px-3 text-white">
                Sign in
              </Link>
            )}
          </div>
        </div>
        <form action="/search" method="get" role="search" className="flex items-center gap-3 border-t border-line py-2">
          <label htmlFor="site-search" className="sr-only">
            Search clothes, shoes, bags and accessories
          </label>
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" strokeLinecap="round" />
          </svg>
          <input
            id="site-search"
            name="q"
            type="search"
            placeholder="Search clothes, shoes, bags and accessories"
            className="min-h-11 w-full bg-transparent text-base text-ink placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-primary"
          />
        </form>
      </div>
    </header>
  );
}
