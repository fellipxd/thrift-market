import type { ComponentProps, ReactNode } from 'react';
import { cx } from '@/lib/format';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cx('rounded-[var(--radius-card)] border border-line bg-surface', className)} />;
}

export function CardSection({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cx('p-4 sm:p-5', className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-lg font-semibold text-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </Card>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-canvas p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold text-primary">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}
