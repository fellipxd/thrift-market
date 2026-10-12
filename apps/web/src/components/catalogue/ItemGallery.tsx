'use client';

import { useEffect, useState } from 'react';
import { cx } from '@/lib/format';

export interface GalleryPhoto {
  url: string;
  thumbUrl: string;
  alt: string;
  role: string;
  caption: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  front: 'Front',
  back: 'Back',
  label: 'Label',
  detail: 'Detail',
  sole: 'Sole',
  lining: 'Lining',
  closure: 'Closure',
  flaw: 'Flaw close-up',
  general: '',
};

/** Accessible gallery: thumbnails are buttons; links to #photo-N (e.g. from a flaw) select that photo. */
export function ItemGallery({ photos, title }: { photos: GalleryPhoto[]; title: string }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const fromHash = () => {
      const m = /^#photo-(\d+)$/.exec(window.location.hash);
      if (m) {
        const n = Number(m[1]) - 1;
        if (n >= 0 && n < photos.length) setIndex(n);
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [photos.length]);
  if (photos.length === 0) {
    return (
      <div className="flex aspect-[4/5] items-center justify-center rounded-[var(--radius-card)] bg-sand text-sm text-muted" role="img" aria-label={`${title}: no photos yet`}>
        No photos yet
      </div>
    );
  }
  const current = photos[index]!;
  return (
    <div id="photos">
      <figure className="relative overflow-hidden rounded-[var(--radius-card)] bg-sand">
        {/* eslint-disable-next-line @next/next/no-img-element -- media is resized and stripped server-side */}
        <img src={current.url} alt={current.alt} className="aspect-[4/5] w-full object-contain" />
        <figcaption className="flex items-center justify-between gap-2 bg-surface/90 px-3 py-2 text-sm text-muted">
          <span>
            Photo {index + 1} of {photos.length}
            {ROLE_LABEL[current.role] ? ` · ${ROLE_LABEL[current.role]}` : ''}
            {current.caption ? ` · ${current.caption}` : ''}
          </span>
          <a href={current.url} target="_blank" rel="noreferrer" className="font-semibold text-primary underline">
            Full size
          </a>
        </figcaption>
      </figure>
      {photos.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Choose a photo">
          {photos.map((p, i) => (
            <li key={p.url} className="shrink-0">
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show photo ${i + 1}${ROLE_LABEL[p.role] ? `: ${ROLE_LABEL[p.role]}` : ''}`}
                aria-pressed={i === index}
                className={cx('block size-16 overflow-hidden rounded-lg border-2 sm:size-20', i === index ? 'border-primary' : 'border-transparent')}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.thumbUrl} alt="" className="h-full w-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
