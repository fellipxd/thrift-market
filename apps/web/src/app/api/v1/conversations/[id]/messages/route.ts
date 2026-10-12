import { conversationUpdates, sendMessage } from '@thrift/application';
import { apiRoute, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';

/** GET ?after=<message id | ISO time> → { messages, offerThreads, block, serverNow } (participants only; marks read). */
export const GET = apiRoute<{ id: string }>(async (req, ctx, params) => {
  const after = req.nextUrl.searchParams.get('after') ?? undefined;
  return conversationUpdates(ctx, params.id, { after });
});

/** POST { body?, mediaId?, clientKey } → the sent message. Retry-safe on clientKey. */
export const POST = apiRoute<{ id: string }>(async (req, ctx, params) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  return { message: await sendMessage(ctx, { ...body, conversationId: params.id }) };
});
