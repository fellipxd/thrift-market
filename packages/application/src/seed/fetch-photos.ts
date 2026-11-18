import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { repoRoot } from '@thrift/database';
import { demoPhotoSubjects } from './demo';
import { DEMO_PHOTO_DIR, DEMO_PHOTO_LICENCES, type DemoPhotoCredit, type DemoPhotoManifest } from './photos';

/**
 * Demo photos from the Openverse catalogue (https://openverse.org), public domain (PDM) or CC0 only.
 *
 * Keyword search alone picks unrelated pictures ("linen shirt" returns buildings), so photos are chosen by a person:
 *
 *   pnpm --filter @thrift/application demo-photos candidates [--item "Relaxed linen shirt"] [--q "linen shirt"] [--source stocksnap]
 *     → .data/demo-photo-candidates/<item>.jpg: a numbered contact sheet per item, with <item>.json listing the ids.
 *   Put the chosen ids in assets/demo-photos/selection.json ({ "<item title>": ["<openverse id>", ...] }), then:
 *
 *   pnpm --filter @thrift/application demo-photos
 *     → downloads exactly the selected photos into assets/demo-photos with manifest.json and CREDITS.md (source,
 *       creator, licence). `pnpm db:reseed` then uses them.
 *
 * Images come through Openverse's own image proxy, so only api.openverse.org needs to be reachable.
 */
const API = 'https://api.openverse.org/v1/images/';
const SELECTION = path.join(DEMO_PHOTO_DIR, 'selection.json');
const CANDIDATE_DIR = path.join(repoRoot(), '.data', 'demo-photo-candidates');
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface OpenverseImage {
  id: string;
  title: string | null;
  url: string;
  creator: string | null;
  license: string;
  license_url: string | null;
  foreign_landing_url: string | null;
  provider: string | null;
  source?: string | null;
  mature?: boolean;
  width?: number | null;
  height?: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const vetted = (r: OpenverseImage) => (DEMO_PHOTO_LICENCES as readonly string[]).includes(r.license) && !r.mature;

/**
 * GET with a 60 s timeout, retrying timeouts, 429 (honouring Retry-After, up to 30 s) and 5xx three times with
 * back-off. Openverse's first uncached query can take ~20 s or time out.
 */
async function politeFetch(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'thrift-market-demo-seed/0.1' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after'));
        console.error(`[photos] HTTP ${res.status} from ${new URL(url).host}; retrying (${attempt}/3)`);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 2000 * attempt);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= 4) throw err;
      console.error(`[photos] ${(err as Error).name} from ${new URL(url).host}; retrying (${attempt}/3)`);
      await sleep(2000 * attempt);
    }
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await politeFetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function getImage(id: string, fullSize: boolean): Promise<Buffer> {
  const res = await politeFetch(`${API}${id}/thumb/${fullSize ? '?full_size=true' : ''}`);
  if (!res.ok) throw new Error(`image ${id}: HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length > 25 * 1024 * 1024) throw new Error(`image ${id} is larger than 25 MB`);
  return raw;
}

async function search(q: string, source?: string): Promise<OpenverseImage[]> {
  const params = new URLSearchParams({ q, license: DEMO_PHOTO_LICENCES.join(','), category: 'photograph', mature: 'false', page_size: '20' });
  if (source) params.set('source', source);
  const body = await getJson<{ results?: OpenverseImage[] }>(`${API}?${params}`);
  return (body.results ?? []).filter(vetted);
}

/** Largest 4:5 portrait crop (at most 960 × 1200, never enlarged), subject-aware, metadata stripped. */
async function toPortrait(raw: Buffer): Promise<Buffer> {
  const img = sharp(raw).rotate();
  const { width = 0, height = 0 } = await img.metadata();
  const h = Math.min(1200, height, Math.floor((width * 5) / 4));
  const w = Math.floor((h * 4) / 5);
  if (w < 320) throw new Error(`too small (${width}×${height})`);
  return img.resize(w, h, { fit: 'cover', position: 'attention' }).jpeg({ quality: 84 }).toBuffer();
}

/** Contact sheet: up to 12 candidates in a 4 × 3 grid, numbered from 1. */
async function contactSheet(images: Buffer[]): Promise<Buffer> {
  const cell = 300;
  const tiles = await Promise.all(
    images.map(async (buf, i) => {
      const label = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${cell}"><rect width="54" height="40" fill="#000" opacity="0.75"/><text x="10" y="29" font-family="sans-serif" font-size="26" font-weight="bold" fill="#fff">${i + 1}</text></svg>`,
      );
      const tile = await sharp(buf).resize(cell, cell, { fit: 'cover' }).composite([{ input: label, top: 0, left: 0 }]).png().toBuffer();
      return { input: tile, left: (i % 4) * cell, top: Math.floor(i / 4) * cell };
    }),
  );
  return sharp({ create: { width: cell * 4, height: cell * 3, channels: 3, background: '#ffffff' } }).composite(tiles).jpeg({ quality: 80 }).toBuffer();
}

async function candidates(): Promise<void> {
  const onlyItem = opt('item');
  const subjects = demoPhotoSubjects().filter((s) => !onlyItem || s.title === onlyItem);
  if (!subjects.length) throw new Error(`No demo item titled "${onlyItem}"`);
  mkdirSync(CANDIDATE_DIR, { recursive: true });
  for (const subject of subjects) {
    const queries = opt('q') ? [opt('q')!] : [subject.query, subject.fallback];
    const sources = opt('source') ? [opt('source')!] : ['stocksnap', undefined];
    const found: OpenverseImage[] = [];
    for (const source of sources) {
      for (const q of queries) {
        if (found.length >= 12) break;
        try {
          for (const r of await search(q, source)) if (found.length < 12 && !found.some((f) => f.id === r.id)) found.push(r);
        } catch (err) {
          console.error(`[photos] ${(err as Error).message}`);
        }
      }
    }
    const thumbs: Buffer[] = [];
    const kept: OpenverseImage[] = [];
    for (const r of found) {
      try {
        thumbs.push(await getImage(r.id, false));
        kept.push(r);
      } catch (err) {
        console.error(`[photos] ${(err as Error).message}`);
      }
    }
    const base = path.join(CANDIDATE_DIR, slug(subject.title));
    if (thumbs.length) writeFileSync(`${base}.jpg`, await contactSheet(thumbs));
    writeFileSync(`${base}.json`, `${JSON.stringify(kept.map((r, i) => ({ n: i + 1, id: r.id, title: r.title, source: r.source ?? r.provider, licence: r.license })), null, 2)}\n`);
    console.log(`[photos] ${subject.title}: ${kept.length} candidates → ${base}.jpg`);
  }
}

async function fetchSelected(): Promise<void> {
  if (!existsSync(SELECTION)) throw new Error(`No ${SELECTION}. Run "demo-photos candidates" and choose photos first.`);
  const selection = JSON.parse(readFileSync(SELECTION, 'utf8')) as Record<string, string[]>;
  const titles = new Set(demoPhotoSubjects().map((s) => s.title));
  const photos: DemoPhotoCredit[] = [];
  for (const [item, ids] of Object.entries(selection)) {
    if (!titles.has(item)) {
      console.error(`[photos] selection names "${item}", which is not a demo item; skipped`);
      continue;
    }
    for (const id of ids) {
      try {
        const meta = await getJson<OpenverseImage>(`${API}${id}/`);
        if (!vetted(meta)) throw new Error(`licence "${meta.license}" is not public domain / CC0`);
        const file = `${slug(item)}-${photos.filter((p) => p.item === item).length + 1}.jpg`;
        mkdirSync(DEMO_PHOTO_DIR, { recursive: true });
        writeFileSync(path.join(DEMO_PHOTO_DIR, file), await toPortrait(await getImage(id, true)));
        photos.push({
          file,
          item,
          title: meta.title ?? 'Untitled',
          creator: meta.creator,
          licence: meta.license as DemoPhotoCredit['licence'],
          licenceUrl: meta.license_url,
          sourcePage: meta.foreign_landing_url ?? meta.url,
          provider: meta.source ?? meta.provider ?? 'unknown',
        });
      } catch (err) {
        console.error(`[photos] ${item} / ${id}: ${(err as Error).message}`);
      }
    }
    console.log(`[photos] ${item}: ${photos.filter((p) => p.item === item).length} photo(s)`);
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
      `Chosen by hand (selection.json) and fetched ${manifest.fetchedAt.slice(0, 10)} from Openverse by`,
      '`pnpm --filter @thrift/application demo-photos`. Public domain (PDM) or CC0 only: no attribution is required, but',
      'sources are listed for provenance. The licence is the uploader’s claim. Demo listings and shops are fictitious.',
      '',
      '| File | Demo item | Image | Creator | Licence | Source |',
      '| --- | --- | --- | --- | --- | --- |',
      ...photos.map((p) => `| ${p.file} | ${p.item} | ${p.title.replace(/\|/g, '/')} | ${(p.creator ?? 'unknown').replace(/\|/g, '/')} | ${p.licence.toUpperCase()} | [${p.provider}](${p.sourcePage}) |`),
      '',
    ].join('\n'),
  );
  console.log(`[photos] ${photos.length} photos for ${new Set(photos.map((p) => p.item)).size} items written to ${DEMO_PHOTO_DIR}`);
}

if (args[0] === 'candidates') await candidates();
else await fetchSelected();
