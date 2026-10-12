import { randomUUID } from 'node:crypto';
import { DomainError } from '@thrift/domain';
import { maybeOne, one } from '@thrift/database';
import { ImageRejectedError, processImage } from '@thrift/providers';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { hmacHex } from '../core/ids';
import { enforceRateLimit } from '../core/rate-limit';
import { getSettings } from '../core/settings';

export type MediaPurpose =
  | 'listing'
  | 'shop_logo'
  | 'shop_banner'
  | 'message'
  | 'dispute_evidence'
  | 'delivery_proof'
  | 'verification_evidence'
  | 'review';

/** Restricted purposes are only served to authorised viewers through signed, short-lived URLs. */
const RESTRICTED: ReadonlySet<MediaPurpose> = new Set(['dispute_evidence', 'verification_evidence', 'delivery_proof', 'message']);

export interface MediaAsset {
  id: string;
  storageKey: string;
  width: number | null;
  height: number | null;
  visibility: 'public' | 'restricted';
}

/**
 * Validates, normalises (strips EXIF/GPS) and stores an uploaded photo. Per-user upload quota applies.
 */
export async function uploadImage(
  ctx: AppContext,
  args: { purpose: MediaPurpose; data: Buffer; altText?: string | null },
): Promise<MediaAsset> {
  const user = requireUser(ctx);
  await enforceRateLimit(ctx.pool, `upload:${user.userId}`, 120, 3600, 'Upload limit reached. Try again later.');
  const settings = await getSettings(ctx.pool);
  let processed;
  try {
    processed = await processImage(args.data, { maxBytes: settings.max_upload_bytes });
  } catch (err) {
    if (err instanceof ImageRejectedError) throw new DomainError('VALIDATION_FAILED', err.message, { fieldErrors: { file: err.message } });
    throw err;
  }
  const id = randomUUID();
  const day = ctx.now().toISOString().slice(0, 10);
  const storageKey = `${args.purpose}/${day}/${id}.webp`;
  await ctx.providers.storage.put(storageKey, processed.main, processed.mime);
  await ctx.providers.storage.put(`${storageKey}.thumb`, processed.thumb, processed.mime);
  const visibility = RESTRICTED.has(args.purpose) ? 'restricted' : 'public';
  await ctx.pool.query(
    `INSERT INTO media_assets (id, owner_user_id, purpose, storage_key, mime_type, bytes, width, height, sha256, visibility, alt_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, user.userId, args.purpose, storageKey, processed.mime, processed.bytes, processed.width, processed.height, processed.sha256, visibility, args.altText ?? null],
  );
  return { id, storageKey, width: processed.width, height: processed.height, visibility };
}

/** Ensures a media asset exists, is ready and belongs to the caller (before attaching it to anything). */
export async function assertOwnMedia(ctx: AppContext, mediaId: string, db = ctx.pool): Promise<{ id: string; purpose: MediaPurpose }> {
  const user = requireUser(ctx);
  const row = await maybeOne<{ id: string; purpose: MediaPurpose }>(
    db,
    `SELECT id, purpose FROM media_assets WHERE id = $1 AND owner_user_id = $2 AND status = 'ready'`,
    [mediaId, user.userId],
  );
  if (!row) throw new DomainError('NOT_FOUND', 'Photo not found. Upload it again.');
  return row;
}

/** Public media URL path. Restricted media requires signMediaUrl(). */
export function mediaPath(storageKey: string, variant: 'main' | 'thumb' = 'main'): string {
  return `/media/${storageKey}${variant === 'thumb' ? '.thumb' : ''}`;
}

/** Short-lived signed URL for restricted media (dispute evidence, chat photos, delivery proof). */
export function signMediaUrl(ctx: AppContext, storageKey: string, ttlSeconds = 600, variant: 'main' | 'thumb' = 'main'): string {
  const exp = Math.floor(ctx.now().getTime() / 1000) + ttlSeconds;
  const key = `${storageKey}${variant === 'thumb' ? '.thumb' : ''}`;
  const sig = hmacHex(ctx.config.appSecret, `${key}:${exp}`);
  return `/media/${key}?exp=${exp}&sig=${sig}`;
}

/**
 * Resolves a media request. Public assets are served to anyone; restricted assets need a valid signature.
 * Returns null when the request must be denied (callers respond 404 to avoid probing).
 */
export async function resolveMediaRequest(
  ctx: AppContext,
  args: { key: string; exp?: string | null; sig?: string | null },
): Promise<{ data: Buffer; contentType: string; cacheControl: string } | null> {
  const baseKey = args.key.endsWith('.thumb') ? args.key.slice(0, -'.thumb'.length) : args.key;
  const asset = await maybeOne<{ visibility: string; status: string; mime_type: string }>(
    ctx.pool,
    'SELECT visibility, status, mime_type FROM media_assets WHERE storage_key = $1',
    [baseKey],
  );
  if (!asset || asset.status !== 'ready') return null;
  if (asset.visibility === 'restricted') {
    const exp = Number(args.exp);
    if (!args.sig || !Number.isFinite(exp) || exp * 1000 < ctx.now().getTime()) return null;
    if (hmacHex(ctx.config.appSecret, `${args.key}:${exp}`) !== args.sig) return null;
  }
  const data = await ctx.providers.storage.get(args.key);
  if (!data) return null;
  return {
    data,
    contentType: asset.mime_type,
    cacheControl: asset.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store',
  };
}

export async function getMediaKey(ctx: AppContext, mediaId: string): Promise<string | null> {
  const row = await maybeOne<{ storage_key: string }>(ctx.pool, 'SELECT storage_key FROM media_assets WHERE id = $1', [mediaId]);
  return row?.storage_key ?? null;
}

export async function countUserMedia(ctx: AppContext): Promise<number> {
  const user = requireUser(ctx);
  const row = await one<{ n: number }>(ctx.pool, 'SELECT count(*)::int AS n FROM media_assets WHERE owner_user_id = $1', [user.userId]);
  return row.n;
}
