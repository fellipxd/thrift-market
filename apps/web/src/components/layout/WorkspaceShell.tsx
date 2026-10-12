'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

export interface WorkspaceNavItem {
  href: string;
  label: string;
  badge?: number | null;
}

/** Seller workspace / admin console shell: sidebar on desktop, scrollable tab strip on mobile. */
export function WorkspaceShell({ title, subtitle, items, children, footer }: { title: string; subtitle?: string; items: WorkspaceNavItem[]; children: ReactNode; footer?: ReactNode }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href.split('/').length <= 2 ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <div className="mx-auto max-w-7xl px-4 py-4 md:flex md:gap-6 md:py-8">
      <aside className="md:w-60 md:shrink-0">
        <div className="hidden rounded-[var(--radius-card)] bg-primary p-4 text-white md:block">
          <p className="text-xl font-bold">{title}</p>
          {subtitle && <p className="mt-0.5 truncate text-sm text-white/85">{subtitle}</p>}
          <nav aria-label={`${title} navigation`} className="mt-4">
            <ul className="space-y-1">
              {items.map((it) => (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    aria-current={isActive(it.href) ? 'page' : undefined}
                    className={cx('flex items-center justify-between rounded-lg px-3 py-2 text-[15px]', isActive(it.href) ? 'bg-white/15 font-semibold' : 'text-white/90 hover:bg-white/10')}
                  >
                    {it.label}
                    {it.badge ? <span className="rounded-full bg-accent px-2 text-xs font-bold">{it.badge}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {footer && <div className="mt-4 border-t border-white/20 pt-3 text-sm">{footer}</div>}
        </div>
        <nav aria-label={`${title} navigation`} className="-mx-4 mb-4 overflow-x-auto border-b border-line px-4 md:hidden">
          <ul className="flex gap-1 whitespace-nowrap pb-2">
            {items.map((it) => (
              <li key={it.href}>
                <Link
                  href={it.href}
                  aria-current={isActive(it.href) ? 'page' : undefined}
                  className={cx('inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-semibold', isActive(it.href) ? 'bg-primary text-white' : 'bg-surface text-ink')}
                >
                  {it.label}
                  {it.badge ? <span className="ml-1.5 rounded-full bg-accent px-1.5 text-xs text-white">{it.badge}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
