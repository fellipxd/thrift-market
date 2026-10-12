import { cx } from '@/lib/format';

/** Item photo served by our media route. Falls back to a labelled placeholder (never a stock image). */
export function Photo({
  storageKey,
  alt,
  variant = 'thumb',
  className,
  src,
}: {
  storageKey?: string | null;
  alt: string;
  variant?: 'thumb' | 'main';
  className?: string;
  src?: string | null;
}) {
  const url = src ?? (storageKey ? `/media/${storageKey}${variant === 'thumb' ? '.thumb' : ''}` : null);
  if (!url) {
    return (
      <div className={cx('flex items-center justify-center bg-sand text-center text-xs text-muted', className)} role="img" aria-label={`${alt} (no photo yet)`}>
        No photo yet
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- media is already resized/stripped server-side
  return <img src={url} alt={alt} loading="lazy" decoding="async" className={cx('bg-sand object-cover', className)} />;
}
