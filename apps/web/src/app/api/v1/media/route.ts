import { DomainError } from '@thrift/domain';
import { mediaPath, signMediaUrl, uploadImage, type MediaPurpose } from '@thrift/application';
import { apiRoute } from '@/server/api';

const PURPOSES: MediaPurpose[] = ['listing', 'shop_logo', 'shop_banner', 'message', 'dispute_evidence', 'delivery_proof', 'verification_evidence', 'review'];

/** POST multipart/form-data { file, purpose, alt? } → { id, url, thumbUrl } */
export const POST = apiRoute(async (req, ctx) => {
  const form = await req.formData();
  const file = form.get('file');
  const purpose = String(form.get('purpose') ?? 'listing') as MediaPurpose;
  if (!PURPOSES.includes(purpose)) throw new DomainError('VALIDATION_FAILED', 'Unknown upload purpose.');
  if (!(file instanceof File)) throw new DomainError('VALIDATION_FAILED', 'Choose a photo to upload.');
  const asset = await uploadImage(ctx, { purpose, data: Buffer.from(await file.arrayBuffer()), altText: (form.get('alt') as string | null) ?? null });
  const url = asset.visibility === 'public' ? mediaPath(asset.storageKey) : signMediaUrl(ctx, asset.storageKey);
  const thumbUrl = asset.visibility === 'public' ? mediaPath(asset.storageKey, 'thumb') : signMediaUrl(ctx, asset.storageKey, 600, 'thumb');
  return { id: asset.id, url, thumbUrl, width: asset.width, height: asset.height };
});
