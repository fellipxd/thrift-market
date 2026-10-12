import Link from 'next/link';
import { routes } from '@/lib/routes';
import { getUser } from '@/server/session';

export function Wordmark() {
  return (
    <Link href={routes.home} className="flex items-baseline gap-1 font-serif text-[22px] leading-none text-primary" aria-label="Thrift Market home">
      <span>Thrift</span>
      <span className="italic text-accent">Market</span>
    </Link>
  );
}

export async function SiteHeader() {
  const user = await getUser();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
        <Wordmark />
        <form action="/search" method="get" role="search" className="hidden flex-1 md:block">
          <label htmlFor="site-search" className="sr-only">
            Search clothes, shoes, bags and accessories
          </label>
          <input
            id="site-search"
            name="q"
            type="search"
            placeholder="Search clothes, shoes, bags…"
            className="w-full max-w-xl rounded-[var(--radius-control)] border border-line-strong/60 bg-surface px-4 py-2.5 text-[15px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </form>
        <nav aria-label="Main" className="ml-auto hidden items-center gap-1 text-[15px] font-medium md:flex">
          <Link href={routes.auctions} className="rounded-lg px-3 py-2 hover:bg-primary-soft">
            Auctions
          </Link>
          <Link href={routes.nearby()} className="rounded-lg px-3 py-2 hover:bg-primary-soft">
            Nearby shops
          </Link>
          <Link href={routes.saved} className="rounded-lg px-3 py-2 hover:bg-primary-soft">
            Saved
          </Link>
          <Link href={routes.inbox} className="rounded-lg px-3 py-2 hover:bg-primary-soft">
            Inbox
          </Link>
          <Link href={routes.sell.home} className="rounded-lg px-3 py-2 hover:bg-primary-soft">
            Sell
          </Link>
          {user ? (
            <Link href={routes.account} className="ml-1 rounded-lg bg-primary px-3 py-2 text-white hover:bg-primary-hover">
              {user.displayName.split(' ')[0]}
            </Link>
          ) : (
            <Link href={routes.auth.signIn()} className="ml-1 rounded-lg bg-primary px-3 py-2 text-white hover:bg-primary-hover">
              Sign in
            </Link>
          )}
        </nav>
        <div className="ml-auto md:hidden">
          {user ? (
            <Link href={routes.notifications} className="rounded-lg px-2 py-2 text-sm font-medium text-primary">
              Notifications
            </Link>
          ) : (
            <Link href={routes.auth.signIn()} className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white">
              Sign in
            </Link>
          )}
        </div>
      </div>
      <form action="/search" method="get" role="search" className="px-4 pb-3 md:hidden">
        <label htmlFor="site-search-mobile" className="sr-only">
          Search
        </label>
        <input
          id="site-search-mobile"
          name="q"
          type="search"
          placeholder="Search clothes, shoes, bags…"
          className="w-full rounded-[var(--radius-control)] border border-line-strong/60 bg-surface px-4 py-2.5 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </form>
    </header>
  );
}
