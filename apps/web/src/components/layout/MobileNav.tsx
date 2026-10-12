'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/lib/format';

const items = [
  { href: '/', label: 'Discover', icon: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z' },
  { href: '/saved', label: 'Saved', icon: 'M12 21s-7-4.35-9.5-8.5C.9 9.6 2.5 5.5 6.4 5.5c2.1 0 3.6 1.2 4.6 2.6 1-1.4 2.5-2.6 4.6-2.6 3.9 0 5.5 4.1 3.9 7-2.5 4.15-9.5 8.5-9.5 8.5z' },
  { href: '/sell', label: 'Sell', icon: 'M12 5v14M5 12h14' },
  { href: '/inbox', label: 'Inbox', icon: 'M4 5h16v11H8l-4 4z' },
  { href: '/account', label: 'Account', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0' },
];

/** Mobile buyer navigation: Discover, Saved, Sell, Inbox, Account. */
export function MobileNav() {
  const pathname = usePathname();
  if (pathname.startsWith('/sell') || pathname.startsWith('/admin') || pathname.startsWith('/sandbox')) return null;
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface md:hidden">
      <ul className="mx-auto grid max-w-md grid-cols-5">
        {items.map((it) => {
          const active = it.href === '/' ? pathname === '/' : pathname.startsWith(it.href);
          return (
            <li key={it.href}>
              <Link
                href={it.href}
                aria-current={active ? 'page' : undefined}
                className={cx('flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold', active ? 'text-primary' : 'text-muted')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round">
                  <path d={it.icon} />
                </svg>
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
