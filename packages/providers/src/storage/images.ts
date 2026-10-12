import { createHash } from 'node:crypto';
import sharp from 'sharp';

export type AllowedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

/** Detects the real type from magic bytes; the client-declared MIME type is never trusted. */
export function sniffImageMime(buf: Buffer): AllowedImageMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export interface ProcessedImage {
  main: Buffer;
  thumb: Buffer;
  mime: 'image/webp';
  width: number;
  height: number;
  sha256: string;
  bytes: number;
}

/**
 * Validates and normalises an uploaded photo: size cap, magic-byte check, full decode (rejects malformed or
 * polyglot files), auto-orientation, metadata stripping (removes EXIF GPS), bounded dimensions.
 * Quality stays high enough to inspect flaws.
 */
export async function processImage(input: Buffer, opts: { maxBytes: number; maxDimension?: number }): Promise<ProcessedImage> {
  if (input.length === 0) throw new ImageRejectedError('The file is empty.');
  if (input.length > opts.maxBytes) throw new ImageRejectedError(`Photos must be under ${Math.round(opts.maxBytes / 1024 / 1024)} MB.`);
  const sniffed = sniffImageMime(input);
  if (!sniffed) throw new ImageRejectedError('Only JPEG, PNG or WebP photos are accepted.');
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new ImageRejectedError('This photo could not be read.');
  }
  if (!meta.width || !meta.height || meta.width < 200 || meta.height < 200) {
    throw new ImageRejectedError('Photos must be at least 200×200 pixels.');
  }
  const maxDim = opts.maxDimension ?? 1600;
  try {
    const pipeline = sharp(input, { limitInputPixels: 40_000_000 }).rotate();
    const mainResult = await pipeline
      .clone()
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer({ resolveWithObject: true });
    const thumb = await pipeline
      .clone()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return {
      main: mainResult.data,
      thumb,
      mime: 'image/webp',
      width: mainResult.info.width,
      height: mainResult.info.height,
      sha256: createHash('sha256').update(mainResult.data).digest('hex'),
      bytes: mainResult.data.length,
    };
  } catch {
    throw new ImageRejectedError('This photo could not be processed.');
  }
}
