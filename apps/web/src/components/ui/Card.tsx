import type { ComponentProps, ReactNode } from 'react';
import { cx } from '@/lib/format';

/** A flat white evidence/input surface (used when extra separation helps). No rounding or shadow. */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cx('border border-line bg-surface', className)} />;
}

/** An editorial section: a fine ink rule and a serif heading over open paper, instead of a boxed card. */
export function CardSection({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('border-t border-ink pt-4 sm:pt-5', className)}>
      {(title || action) && (
        <div className="mb-4 flex items-baseline justify-between gap-3">
          {title && <h2 className="font-serif text-2xl leading-tight text-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="border-t border-line pt-3">
      <div className="label-caps text-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}
