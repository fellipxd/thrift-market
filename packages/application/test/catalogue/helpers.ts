import { randomUUID } from 'node:crypto';
import { testServices } from '../support';

/** Inserts a ready media asset directly (tests do not exercise the image pipeline here). */
export async function insertMedia(ownerId: string, purpose: 'listing' | 'verification_evidence' = 'listing'): Promise<string> {
  const id = randomUUID();
  await testServices().pool.query(
    `INSERT INTO media_assets (id, owner_user_id, purpose, storage_key, mime_type, bytes, width, height, sha256, visibility)
     VALUES ($1, $2, $3, $4, 'image/webp', 1000, 800, 1000, 'x', $5)`,
    [id, ownerId, purpose, `${purpose}/test/${id}.webp`, purpose === 'listing' ? 'public' : 'restricted'],
  );
  return id;
}
