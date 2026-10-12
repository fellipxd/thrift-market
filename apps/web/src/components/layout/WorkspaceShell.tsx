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
    <div className="mx-auto max-w-[1280px] px-4 py-6 md:flex md:gap-10 md:px-8 md:py-10 xl:px-12">
      <aside className="md:w-56 md:shrink-0">
        <div className="hidden md:block">
          <p className="display text-3xl text-ink">{title}</p>
          {subtitle && <p className="mt-1 truncate text-sm text-muted">{subtitle}</p>}
          <nav aria-label={`${title} navigation`} className="mt-6 border-t border-ink">
            <ul>
              {items.map((it) => (
                <li key={it.href} className="border-b border-line">
                  <Link
                    href={it.href}
                    aria-current={isActive(it.href) ? 'page' : undefined}
                    className={cx(
                      'flex min-h-11 items-center justify-between border-l-2 py-2 pl-3 pr-1 text-[15px]',
                      isActive(it.href) ? 'border-primary font-semibold text-primary' : 'border-transparent text-ink hover:border-line-strong',
                    )}
                  >
                    {it.label}
                    {it.badge ? <span className="bg-accent px-1.5 text-xs font-semibold text-white">{it.badge}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {footer && <div className="mt-4 text-sm">{footer}</div>}
        </div>
        {/* Narrow screens: a disclosure menu instead of a sideways-scrolling strip (no essential horizontal dragging). */}
        <details className="group mb-6 border-y border-ink md:hidden">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3">
            <span>
              <span className="label-caps block text-muted">{title}</span>
              <span className="font-semibold text-ink">{items.find((it) => isActive(it.href))?.label ?? 'Menu'}</span>
            </span>
            <span className="label-caps text-primary">
              <span className="group-open:hidden">Menu</span>
              <span className="hidden group-open:inline">Close</span>
            </span>
          </summary>
          <nav aria-label={`${title} navigation`}>
            <ul className="border-t border-line">
              {items.map((it) => (
                <li key={it.href} className="border-b border-line last:border-b-0">
                  <Link
                    href={it.href}
                    aria-current={isActive(it.href) ? 'page' : undefined}
                    className={cx('flex min-h-11 items-center justify-between text-[15px]', isActive(it.href) ? 'font-semibold text-primary' : 'text-ink')}
                  >
                    {it.label}
                    {it.badge ? <span className="bg-accent px-1.5 text-xs text-white">{it.badge}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </details>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
