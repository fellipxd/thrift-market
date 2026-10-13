import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadDemoPhotos } from '../../src/seed/photos';

describe('demo photos', () => {
  it('is empty without a manifest, and only loads vetted licences from inside the folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'demo-photos-'));
    expect(loadDemoPhotos(dir).size).toBe(0);

    const jpeg = await sharp({ create: { width: 40, height: 50, channels: 3, background: '#887766' } }).jpeg().toBuffer();
    for (const f of ['a.jpg', 'b.jpg', 'c.jpg']) writeFileSync(path.join(dir, f), jpeg);
    const base = { title: 't', creator: null, licenceUrl: null, sourcePage: 'https://example.org/x', provider: 'test' };
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        fetchedAt: '2026-10-13T00:00:00Z',
        photos: [
          { ...base, file: 'a.jpg', item: 'Relaxed linen shirt', licence: 'cc0' },
          { ...base, file: 'b.jpg', item: 'Relaxed linen shirt', licence: 'pdm' },
          { ...base, file: 'c.jpg', item: 'Relaxed linen shirt', licence: 'by-nc' },
          { ...base, file: '../a.jpg', item: 'Relaxed linen shirt', licence: 'cc0' },
          { ...base, file: 'missing.jpg', item: 'Tailored blazer', licence: 'cc0' },
        ],
      }),
    );
    const photos = loadDemoPhotos(dir);
    expect([...photos.keys()]).toEqual(['Relaxed linen shirt']);
    expect(photos.get('Relaxed linen shirt')!.map((p) => p.credit.file)).toEqual(['a.jpg', 'b.jpg']);
    expect(photos.get('Relaxed linen shirt')![0]!.buffer.equals(jpeg)).toBe(true);
  });
});
