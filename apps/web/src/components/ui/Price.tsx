import { formatNaira } from '@thrift/domain';
import { cx } from '@/lib/format';

export function Price({ minor, className, size = 'md' }: { minor: number; className?: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const sizes = { sm: 'text-sm', md: 'text-base', lg: 'text-[1.75rem]', xl: 'text-4xl' };
  return <span className={cx('font-semibold tabular-nums text-ink', sizes[size], className)}>{formatNaira(minor)}</span>;
}
