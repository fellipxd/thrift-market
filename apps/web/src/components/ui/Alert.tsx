import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

type AlertTone = 'info' | 'success' | 'warning' | 'error';

const styles: Record<AlertTone, string> = {
  info: 'border-info bg-info-soft text-info',
  success: 'border-success bg-success-soft text-success',
  warning: 'border-warning bg-warning-soft text-warning',
  error: 'border-error bg-error-soft text-error',
};

export function Alert({ tone = 'info', title, children, className }: { tone?: AlertTone; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('border-l-2 px-4 py-3 text-sm', styles[tone], className)}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cx(title ? 'mt-1' : '', 'text-ink/90')}>{children}</div>}
    </div>
  );
}
