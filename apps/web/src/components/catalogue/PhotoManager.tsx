'use client';

import { useRef, useState } from 'react';
import { ActionForm, SubmitButton, type FormActionState } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { buttonClass } from '@/components/ui/Button';

const ROLES: { value: string; label: string }[] = [
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
  { value: 'label', label: 'Label / tag' },
  { value: 'detail', label: 'Detail' },
  { value: 'sole', label: 'Sole / heel' },
  { value: 'lining', label: 'Lining' },
  { value: 'closure', label: 'Closure / zip' },
  { value: 'flaw', label: 'Flaw close-up' },
  { value: 'general', label: 'Other' },
];

export interface ManagedPhoto {
  mediaId: string;
  role: string;
  caption: string | null;
  thumbUrl: string;
}

/**
 * Uploads photos to /api/v1/media (validated, metadata-stripped server-side), lets the seller order them and
 * tag their role, then saves the ordered set with a server action.
 */
export function PhotoManager({
  listingId,
  initial,
  maxPhotos,
  lockedReason,
  recommendedRoles,
  action,
}: {
  listingId: string;
  initial: ManagedPhoto[];
  maxPhotos: number;
  lockedReason?: string;
  recommendedRoles: string[];
  action: (prev: FormActionState, form: FormData) => Promise<FormActionState>;
}) {
  const [photos, setPhotos] = useState<ManagedPhoto[]>(initial);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(photos) !== JSON.stringify(initial);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const room = maxPhotos - photos.length;
    const list = Array.from(files).slice(0, Math.max(room, 0));
    if (list.length < files.length) setError(`Only ${maxPhotos} photos are allowed per listing.`);
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const body = new FormData();
        body.set('file', file);
        body.set('purpose', 'listing');
        const res = await fetch('/api/v1/media', { method: 'POST', body });
        const json = (await res.json()) as { id?: string; thumbUrl?: string; error?: { message: string } };
        if (!res.ok || !json.id || !json.thumbUrl) throw new Error(json.error?.message ?? 'Upload failed.');
        const used = new Set(photos.map((p) => p.role));
        const nextRole = recommendedRoles.find((r) => !used.has(r)) ?? 'general';
        setPhotos((prev) => [...prev, { mediaId: json.id!, role: prev.length === 0 ? (recommendedRoles[0] ?? 'front') : nextRole, caption: null, thumbUrl: json.thumbUrl! }]);
      } catch (err) {
        setError(`${file.name}: ${(err as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  const move = (i: number, d: -1 | 1) =>
    setPhotos((prev) => {
      const next = [...prev];
      const j = i + d;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const update = (i: number, patch: Partial<ManagedPhoto>) => setPhotos((prev) => prev.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const remove = (i: number) => setPhotos((prev) => prev.filter((_, k) => k !== i));

  if (lockedReason) {
    return (
      <div className="space-y-3">
        <Alert tone="info">{lockedReason}</Alert>
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {initial.map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <li key={p.mediaId}><img src={p.thumbUrl} alt="" className="aspect-square w-full rounded-lg object-cover" /></li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <ActionForm action={action} className="space-y-4" refreshOnSuccess>
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="photos" value={JSON.stringify(photos.map((p) => ({ mediaId: p.mediaId, role: p.role, caption: p.caption })))} />
      <p className="text-sm text-muted">
        Use photos of the actual piece in good light, including labels and any wear. Recommended for this category: {recommendedRoles.join(', ') || 'front and back'}. Filters that hide wear are not allowed.
      </p>
      {photos.length > 0 && (
        <ol className="grid gap-3 sm:grid-cols-2">
          {photos.map((p, i) => (
            <li key={p.mediaId} className="flex gap-3 rounded-[var(--radius-control)] border border-line p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.thumbUrl} alt={`Photo ${i + 1}`} className="size-24 shrink-0 rounded-lg object-cover" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs font-semibold text-muted">Photo {i + 1}{i === 0 ? ' · cover' : ''}</p>
                <label className="block text-sm">
                  <span className="sr-only">Role of photo {i + 1}</span>
                  <select value={p.role} onChange={(e) => update(i, { role: e.target.value })} className="w-full rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-sm">
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="sr-only">Caption for photo {i + 1}</span>
                  <input
                    value={p.caption ?? ''}
                    maxLength={140}
                    onChange={(e) => update(i, { caption: e.target.value || null })}
                    placeholder="Caption (optional)"
                    className="w-full rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-sm"
                  />
                </label>
                <div className="flex gap-1">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className={buttonClass('ghost', 'sm')} aria-label={`Move photo ${i + 1} earlier`}>↑</button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === photos.length - 1} className={buttonClass('ghost', 'sm')} aria-label={`Move photo ${i + 1} later`}>↓</button>
                  <button type="button" onClick={() => remove(i)} className={buttonClass('ghost', 'sm', 'text-error')} aria-label={`Remove photo ${i + 1}`}>Remove</button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <label className={buttonClass('secondary', 'md', 'cursor-pointer')}>
          {uploading > 0 ? `Uploading ${uploading}…` : 'Add photos'}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="sr-only"
            disabled={uploading > 0 || photos.length >= maxPhotos}
            onChange={(e) => upload(e.target.files)}
          />
        </label>
        <SubmitButton pendingText="Saving photos…" disabled={uploading > 0 || !dirty}>Save photos</SubmitButton>
        <span className="text-sm text-muted">{photos.length}/{maxPhotos}{dirty ? ' · unsaved changes' : ''}</span>
      </div>
    </ActionForm>
  );
}
