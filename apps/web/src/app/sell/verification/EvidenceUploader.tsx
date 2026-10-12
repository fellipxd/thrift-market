'use client';

import { useState } from 'react';
import { buttonClass } from '@/components/ui/Button';

/** Uploads identity evidence as restricted media (served only to trust & safety via signed URLs). */
export function EvidenceUploader() {
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onFiles(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    setError(null);
    for (const file of Array.from(files).slice(0, 4 - ids.length)) {
      const body = new FormData();
      body.set('file', file);
      body.set('purpose', 'verification_evidence');
      const res = await fetch('/api/v1/media', { method: 'POST', body });
      const json = (await res.json()) as { id?: string; error?: { message: string } };
      if (res.ok && json.id) setIds((prev) => [...prev, json.id!]);
      else setError(json.error?.message ?? 'Upload failed.');
    }
    setBusy(false);
  }
  return (
    <div className="space-y-2">
      {ids.map((id) => (
        <input key={id} type="hidden" name="evidenceMediaIds" value={id} />
      ))}
      <label className={buttonClass('secondary', 'md', 'cursor-pointer')}>
        {busy ? 'Uploading…' : 'Upload document photo'}
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" disabled={busy || ids.length >= 4} onChange={(e) => onFiles(e.target.files)} />
      </label>
      <p className="text-sm text-muted" aria-live="polite">{ids.length} of up to 4 photos uploaded. Photos are visible only to our trust & safety team.</p>
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}
