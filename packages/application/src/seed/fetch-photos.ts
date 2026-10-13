import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { demoPhotoSubjects } from './demo';
import { DEMO_PHOTO_DIR, DEMO_PHOTO_LICENCES, type DemoPhotoCredit, type DemoPhotoManifest } from './photos';

/**
 * `pnpm --filter @thrift/application demo-photos [--per-item 2]` — downloads public-domain / CC0 photographs for the
 * demo items from the Openverse catalogue (https://openverse.org) into assets/demo-photos, with a manifest.json and
 * CREDITS.md recording each image's source, creator and licence. Then `pnpm db:reseed` uses them.
 *
 * Needs outbound HTTPS to api.openverse.org and to the hosts the images live on (mostly live.staticflickr.com and
 * upload.wikimedia.org). Review the downloaded photos before committing them: a licence tag is the uploader's claim.
 */
const API = 'https://api.openverse.org/v1/images/';
const args = process.argv.slice(2);
const perItemArg = Number(args[args.indexOf('--per-item') + 1]);
const perItem = args.includes('--per-item') && perItemArg > 0 ? Math.min(perItemArg, 3) : 2;

interface OpenverseImage {
  id: string;
  title: string | null;
  url: string;
  creator: string | null;
  license: string;
  license_url: string | null;
  foreign_landing_url: string | null;
  provider: string | null;
  mature?: boolean;
  width?: number | null;
  height?: number | null;
}

async function search(q: string): Promise<OpenverseImage[]> {
  const params = new URLSearchParams({ q, license: DEMO_PHOTO_LICENCES.join(','), category: 'photograph', mature: 'false', page_size: '20' });
  const res = await fetch(`${API}?${params}`, { headers: { 'User-Agent': 'thrift-market-demo-seed/0.1' } });
  if (!res.ok) throw new Error(`Openverse search "${q}" failed: HTTP ${res.status}`);
  const body = (await res.json()) as { results?: OpenverseImage[] };
  return (body.results ?? []).filter(
    (r) => (DEMO_PHOTO_LICENCES as readonly string[]).includes(r.license) && !r.mature && (!r.width || !r.height || (r.width >= 600 && r.height >= 600)),
  );
}

/** Portrait 4:5 JPEG, at most 1200 px tall, metadata (including GPS) stripped. */
async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'thrift-market-demo-seed/0.1' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length > 25 * 1024 * 1024) throw new Error('image larger than 25 MB');
  return sharp(raw).rotate().resize(960, 1200, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82 }).toBuffer();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const photos: DemoPhotoCredit[] = [];
const used = new Set<string>();
for (const subject of demoPhotoSubjects()) {
  let got = 0;
  for (const q of [subject.query, subject.fallback]) {
    if (got >= perItem) break;
    let results: OpenverseImage[];
    try {
      results = await search(q);
    } catch (err) {
      console.error(`[photos] ${(err as Error).message}`);
      continue;
    }
    for (const r of results) {
      if (got >= perItem) break;
      if (used.has(r.id)) continue;
      try {
        const jpeg = await download(r.url);
        const file = `${slug(subject.title)}-${got + 1}.jpg`;
        mkdirSync(DEMO_PHOTO_DIR, { recursive: true });
        writeFileSync(path.join(DEMO_PHOTO_DIR, file), jpeg);
        used.add(r.id);
        photos.push({
          file,
          item: subject.title,
          title: r.title ?? 'Untitled',
          creator: r.creator,
          licence: r.license as DemoPhotoCredit['licence'],
          licenceUrl: r.license_url,
          sourcePage: r.foreign_landing_url ?? r.url,
          provider: r.provider ?? 'unknown',
        });
        got++;
      } catch (err) {
        console.error(`[photos] skipped ${r.url}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`[photos] ${subject.title}: ${got} photo(s)`);
}

if (photos.length === 0) {
  console.error('[photos] nothing downloaded (is api.openverse.org reachable?); existing photos left untouched');
  process.exit(1);
}
const manifest: DemoPhotoManifest = { fetchedAt: new Date().toISOString(), photos };
writeFileSync(path.join(DEMO_PHOTO_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  path.join(DEMO_PHOTO_DIR, 'CREDITS.md'),
  [
    '# Demo photo credits',
    '',
    `Fetched ${manifest.fetchedAt} from Openverse by \`pnpm --filter @thrift/application demo-photos\`. Public domain (PDM) or`,
    'CC0 only; no attribution is required, but sources are listed for provenance. Demo listings are fictitious.',
    '',
    '| File | Demo item | Image | Creator | Licence | Source |',
    '| --- | --- | --- | --- | --- | --- |',
    ...photos.map((p) => `| ${p.file} | ${p.item} | ${p.title.replace(/\|/g, '/')} | ${(p.creator ?? 'unknown').replace(/\|/g, '/')} | ${p.licence.toUpperCase()} | [${p.provider}](${p.sourcePage}) |`),
    '',
  ].join('\n'),
);
console.log(`[photos] ${photos.length} photos for ${new Set(photos.map((p) => p.item)).size} items written to ${DEMO_PHOTO_DIR}`);
