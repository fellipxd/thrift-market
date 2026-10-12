import { placeBid } from '@thrift/application';
import { apiRoute, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';

/** POST { amount, idempotencyKey, addressId? } → the accepted bid. Retry-safe on idempotencyKey. */
export const POST = apiRoute<{ id: string }>(async (req, ctx, params) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  return placeBid(ctx, { ...body, auctionId: params.id });
});
