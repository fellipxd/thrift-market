import type { ReactNode } from 'react';

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 sm:p-8">
        <h1 className="font-serif text-3xl text-ink">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
    </div>
  );
}
