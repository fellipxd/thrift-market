import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

export type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'error' | 'info';

// Flat editorial labels: a fine border in the tone colour plus text; never colour alone.
const tones: Record<Tone, string> = {
  neutral: 'border-line-strong/60 bg-canvas text-ink',
  primary: 'border-primary/50 bg-primary-soft text-primary',
  accent: 'border-accent/50 bg-accent-soft text-accent',
  success: 'border-success/50 bg-success-soft text-success',
  warning: 'border-warning/50 bg-warning-soft text-warning',
  error: 'border-error/50 bg-error-soft text-error',
  info: 'border-info/50 bg-info-soft text-info',
};

/** Status labels always include text; colour is a secondary cue. */
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 border px-1.5 py-0.5 text-xs font-semibold tracking-[0.02em]', tones[tone], className)}>{children}</span>;
}
