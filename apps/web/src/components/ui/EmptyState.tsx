import type { ReactNode } from 'react';

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-line-strong/50 bg-surface px-6 py-10 text-center">
      <p className="font-serif text-xl text-ink">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
