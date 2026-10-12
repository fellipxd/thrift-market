import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

export type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'error' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'bg-sand text-ink',
  primary: 'bg-primary-soft text-primary',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  error: 'bg-error-soft text-error',
  info: 'bg-info-soft text-info',
};

/** Status labels always include text; colour is a secondary cue. */
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold', tones[tone], className)}>{children}</span>;
}
