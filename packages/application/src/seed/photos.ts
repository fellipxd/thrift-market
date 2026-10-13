import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@thrift/database';

/**
 * Optional real demo photos (fetched by `pnpm --filter @thrift/application demo-photos`). Only public-domain or CC0
 * images are accepted, each with its source recorded in manifest.json. When the folder is missing or an item has no
 * photos, the seed uses its generated illustrations instead.
 */
export const DEMO_PHOTO_DIR = path.join(repoRoot(), 'assets', 'demo-photos');
export const DEMO_PHOTO_LICENCES = ['cc0', 'pdm'] as const;

export interface DemoPhotoCredit {
  /** File name inside the photo folder. */
  file: string;
  /** Demo item title the photo illustrates. */
  item: string;
  title: string;
  creator: string | null;
  licence: (typeof DEMO_PHOTO_LICENCES)[number];
  licenceUrl: string | null;
  /** Page the image came from (for provenance), and the provider behind it. */
  sourcePage: string;
  provider: string;
}

export interface DemoPhotoManifest {
  fetchedAt: string;
  photos: DemoPhotoCredit[];
}

/** Photos per demo item title (in manifest order); empty when nothing usable is on disk. */
export function loadDemoPhotos(dir = DEMO_PHOTO_DIR): Map<string, { buffer: Buffer; credit: DemoPhotoCredit }[]> {
  const out = new Map<string, { buffer: Buffer; credit: DemoPhotoCredit }[]>();
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return out;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DemoPhotoManifest;
  for (const credit of manifest.photos ?? []) {
    // Never trust a manifest entry outside the folder or with a licence we did not vet.
    if (!(DEMO_PHOTO_LICENCES as readonly string[]).includes(credit.licence)) continue;
    if (path.basename(credit.file) !== credit.file) continue;
    const file = path.join(dir, credit.file);
    if (!existsSync(file)) continue;
    out.set(credit.item, [...(out.get(credit.item) ?? []), { buffer: readFileSync(file), credit }]);
  }
  return out;
}
