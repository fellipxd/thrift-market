import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

type AlertTone = 'info' | 'success' | 'warning' | 'error';

const styles: Record<AlertTone, string> = {
  info: 'border-info/30 bg-info-soft text-info',
  success: 'border-success/30 bg-success-soft text-success',
  warning: 'border-warning/30 bg-warning-soft text-warning',
  error: 'border-error/30 bg-error-soft text-error',
};

export function Alert({ tone = 'info', title, children, className }: { tone?: AlertTone; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-[var(--radius-control)] border px-4 py-3 text-sm', styles[tone], className)}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cx(title ? 'mt-1' : '', 'text-ink/90')}>{children}</div>}
    </div>
  );
}
