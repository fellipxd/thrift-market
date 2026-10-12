import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from '@/lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
type Size = 'sm' | 'md' | 'lg';

// One filled primary action per decision region; outlined secondary; text-style ghost. Square editorial geometry.
const base =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-semibold tracking-[0.02em] transition-colors disabled:cursor-not-allowed disabled:opacity-55 text-center';
const variants: Record<Variant, string> = {
  primary: 'border border-primary bg-primary text-white hover:bg-primary-hover',
  secondary: 'border border-ink bg-transparent text-ink hover:bg-ink hover:text-canvas',
  ghost: 'text-primary underline-offset-4 hover:underline',
  danger: 'border border-error bg-error text-white hover:brightness-95',
  accent: 'border border-accent bg-accent text-white hover:brightness-95',
};
const sizes: Record<Size, string> = {
  sm: 'min-h-10 px-3 text-sm',
  md: 'min-h-11 px-5 text-[15px]',
  lg: 'min-h-12 px-7 text-base',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra?: string): string {
  return cx(base, variants[variant], sizes[size], extra);
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return <button {...props} className={buttonClass(variant, size, className)} />;
}

export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...rest
}: { href: string; variant?: Variant; size?: Size; className?: string; children: ReactNode } & Omit<ComponentProps<typeof Link>, 'href' | 'className'>) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}
