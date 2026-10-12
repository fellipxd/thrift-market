import { getAuctionView } from '@thrift/application';
import { apiRoute } from '@/server/api';

export const dynamic = 'force-dynamic';

/** GET → the auction snapshot (public; viewer-specific fields only when signed in). Polled by the auction page. */
export const GET = apiRoute<{ id: string }>(async (_req, ctx, params) => getAuctionView(ctx, params.id));
