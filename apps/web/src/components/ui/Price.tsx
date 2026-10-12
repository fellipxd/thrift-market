import { formatNaira } from '@thrift/domain';
import { cx } from '@/lib/format';

export function Price({ minor, className, size = 'md' }: { minor: number; className?: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const sizes = { sm: 'text-sm', md: 'text-base', lg: 'text-2xl', xl: 'text-4xl' };
  return <span className={cx('font-bold tabular-nums text-primary', sizes[size], className)}>{formatNaira(minor)}</span>;
}
