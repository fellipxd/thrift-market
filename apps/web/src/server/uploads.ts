import 'server-only';
import { uploadImage, type AppContext, type MediaPurpose } from '@thrift/application';
import { DomainError } from '@thrift/domain';

const MAX_BYTES = 10 * 1024 * 1024;

/** Uploads the photos attached to a form field (restricted purposes stay private) and returns their media ids. */
export async function uploadFormImages(ctx: AppContext, form: FormData, field: string, purpose: MediaPurpose, max: number): Promise<string[]> {
  const files = form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > max) throw new DomainError('VALIDATION_FAILED', `Attach up to ${max} photos.`, { fieldErrors: { [field]: `Up to ${max} photos.` } });
  const ids: string[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) throw new DomainError('VALIDATION_FAILED', 'Photos can be up to 10 MB each.', { fieldErrors: { [field]: 'Choose smaller photos.' } });
    const asset = await uploadImage(ctx, { purpose, data: Buffer.from(await f.arrayBuffer()), altText: null });
    ids.push(asset.id);
  }
  return ids;
}
