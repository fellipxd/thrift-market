import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { isDomainError } from '@thrift/domain';
import { InMemoryStorage, processImage, sniffImageMime } from '@thrift/providers';
import { resolveMediaRequest, signMediaUrl, uploadImage } from '../../src';
import { closeTestServices, createUser, guestCtx, testServices } from '../support';

afterAll(closeTestServices);

const MAX = 8 * 1024 * 1024;

/** A real photo-sized JPEG with some texture (solid colours compress to nothing). */
async function jpeg(width = 800, height = 600, extra?: (s: sharp.Sharp) => sharp.Sharp): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + (i >> 7)) & 0xff;
  const base = sharp(raw, { raw: { width, height, channels: 3 } });
  return (extra ? extra(base) : base).jpeg({ quality: 85 }).toBuffer();
}

/** A tiny valid PNG whose header then claims huge dimensions (a decompression-bomb shape). */
function pngClaiming(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(1024))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rejects = async (input: Buffer, message: RegExp) => expect(processImage(input, { maxBytes: MAX })).rejects.toThrow(message);

describe('T15: upload validation (never trusts the declared type)', () => {
  it('rejects empty, oversized, non-image and forged files', async () => {
    await rejects(Buffer.alloc(0), /empty/);
    await rejects(Buffer.alloc(MAX + 1, 0xff), /under 8 MB/);
    await rejects(Buffer.from('just text pretending to be photo.jpg'), /Only JPEG, PNG or WebP/);
    await rejects(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), /Only JPEG, PNG or WebP/);
    await rejects(Buffer.from('<!doctype html><script>alert(1)</script>'), /Only JPEG, PNG or WebP/);
    await rejects(Buffer.from('GIF89a\x01\x00\x01\x00'), /Only JPEG, PNG or WebP/);
    // Correct magic bytes, garbage after them: the full decode refuses it.
    await rejects(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>'.repeat(20))]), /could not be read/);
    await rejects(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('not really a jpeg'.repeat(30))]), /could not be (read|processed)/);
  });

  it('rejects too-small photos and decompression bombs without decoding them', async () => {
    await rejects(await jpeg(120, 120), /at least 200×200/);
    const bomb = pngClaiming(30_000, 30_000);
    expect(bomb.length).toBeLessThan(2_000);
    expect(sniffImageMime(bomb)).toBe('image/png');
    await rejects(bomb, /could not be (read|processed)/);
  });

  it('re-encodes to bounded WebP, applies orientation and strips metadata (incl. GPS)', async () => {
    const withGps = await jpeg(2400, 1200, (s) =>
      s
        .withExif({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 27/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '3/1 23/1 0/1' } })
        .withMetadata({ orientation: 6 }),
    );
    const before = await sharp(withGps).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif?.includes(Buffer.from('TestCam'))).toBe(true);
    const out = await processImage(withGps, { maxBytes: MAX });
    expect(out.mime).toBe('image/webp');
    expect(sniffImageMime(out.main)).toBe('image/webp');
    // Orientation 6 (rotate 90°) is applied before resizing: the 2400×1200 photo becomes portrait, longest side 1600.
    expect([out.width, out.height]).toEqual([800, 1600]);
    const meta = await sharp(out.main).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(Math.max(...[(await sharp(out.thumb).metadata()).width!, (await sharp(out.thumb).metadata()).height!])).toBe(480);
  });

  it('drops anything appended to a valid photo (polyglot payloads are never stored)', async () => {
    const payload = '<script>alert(document.cookie)</script>';
    const polyglot = Buffer.concat([await jpeg(), Buffer.from(payload)]);
    const out = await processImage(polyglot, { maxBytes: MAX });
    expect(out.main.includes(Buffer.from('<script'))).toBe(false);
    expect(out.thumb.includes(Buffer.from('<script'))).toBe(false);
  });
});

describe('T15: stored and served media', () => {
  const storage = () => testServices().providers.storage as InMemoryStorage;

  it('stores only the re-encoded files, caps alt text and marks evidence restricted', async () => {
    const user = await createUser();
    const asset = await uploadImage(user.ctx, { purpose: 'listing', data: await jpeg(), altText: `  ${'x'.repeat(500)}  ` });
    expect(asset.visibility).toBe('public');
    expect(asset.storageKey).toMatch(/^listing\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.webp$/);
    expect(sniffImageMime(storage().objects.get(asset.storageKey)!)).toBe('image/webp');
    expect(sniffImageMime(storage().objects.get(`${asset.storageKey}.thumb`)!)).toBe('image/webp');
    const row = (await testServices().pool.query('SELECT mime_type, alt_text, sha256 FROM media_assets WHERE id = $1', [asset.id])).rows[0];
    expect(row.mime_type).toBe('image/webp');
    expect(row.alt_text).toHaveLength(300);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);

    for (const purpose of ['dispute_evidence', 'verification_evidence', 'delivery_proof', 'message'] as const) {
      expect((await uploadImage(user.ctx, { purpose, data: await jpeg() })).visibility).toBe('restricted');
    }
  });

  it('a rejected upload stores nothing and needs a signed-in user', async () => {
    const user = await createUser();
    const before = storage().objects.size;
    const err = await uploadImage(user.ctx, { purpose: 'listing', data: Buffer.from('<html>not a photo</html>') }).catch((e) => e);
    expect(isDomainError(err) && err.code).toBe('VALIDATION_FAILED');
    expect(err.details.fieldErrors.file).toMatch(/Only JPEG, PNG or WebP/);
    expect(storage().objects.size).toBe(before);
    expect((await testServices().pool.query('SELECT count(*)::int AS n FROM media_assets WHERE owner_user_id = $1', [user.id])).rows[0].n).toBe(0);
    await expect(uploadImage(guestCtx(), { purpose: 'listing', data: await jpeg() })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('enforces the per-user upload quota before any processing (rejected files count too)', async () => {
    const user = await createUser();
    await testServices().pool.query(
      `INSERT INTO rate_limit_counters (bucket, window_start, count) VALUES ($1, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 120)`,
      [`upload:${user.id}`],
    );
    const before = storage().objects.size;
    await expect(uploadImage(user.ctx, { purpose: 'listing', data: await jpeg() })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(storage().objects.size).toBe(before);
  });

  it('serves public media to anyone and restricted media only with a valid, unexpired signature for that exact file', async () => {
    const user = await createUser();
    const pub = await uploadImage(user.ctx, { purpose: 'listing', data: await jpeg() });
    const evidence = await uploadImage(user.ctx, { purpose: 'dispute_evidence', data: await jpeg() });
    const guest = guestCtx();
    const served = await resolveMediaRequest(guest, { key: pub.storageKey });
    expect(served).toMatchObject({ contentType: 'image/webp', cacheControl: expect.stringContaining('public') });

    expect(await resolveMediaRequest(guest, { key: evidence.storageKey })).toBeNull();
    const signed = new URL(signMediaUrl(guest, evidence.storageKey), 'http://x');
    const exp = signed.searchParams.get('exp')!;
    const sig = signed.searchParams.get('sig')!;
    const ok = await resolveMediaRequest(guest, { key: evidence.storageKey, exp, sig });
    expect(ok).toMatchObject({ cacheControl: 'private, no-store' });

    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    expect(await resolveMediaRequest(guest, { key: evidence.storageKey, exp, sig: flipped })).toBeNull();
    expect(await resolveMediaRequest(guest, { key: evidence.storageKey, exp, sig: 'not-hex' })).toBeNull();
    expect(await resolveMediaRequest(guest, { key: evidence.storageKey, exp: String(Number(exp) + 3600), sig })).toBeNull();
    // The main file's signature does not open the thumbnail (each signature covers one exact key).
    expect(await resolveMediaRequest(guest, { key: `${evidence.storageKey}.thumb`, exp, sig })).toBeNull();
    // Expired.
    const old = signMediaUrl({ ...guest, now: () => new Date(Date.now() - 3_600_000) }, evidence.storageKey, 60);
    const o = new URL(old, 'http://x');
    expect(await resolveMediaRequest(guest, { key: evidence.storageKey, exp: o.searchParams.get('exp'), sig: o.searchParams.get('sig') })).toBeNull();
    // Unknown and path-like keys never reach storage.
    expect(await resolveMediaRequest(guest, { key: 'listing/2026-01-01/00000000-0000-0000-0000-000000000000.webp' })).toBeNull();
    expect(await resolveMediaRequest(guest, { key: '../../etc/passwd' })).toBeNull();
  });
});
