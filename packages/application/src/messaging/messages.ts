import { many, maybeOne, one, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';
import { signMediaUrl } from '../media/media';
import type { ConversationRole } from './access';
import { assessMessageSafety } from './safety';

export type MessageKind = 'text' | 'image' | 'offer' | 'system';

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_user_id: string | null;
  kind: MessageKind;
  body: string;
  media_id: string | null;
  offer_id: string | null;
  hidden_at: Date | null;
  created_at: Date;
  [k: string]: unknown;
}

/** Client-safe message projection. Restricted chat photos are returned as short-lived signed URLs. */
export interface MessageView {
  id: string;
  conversationId: string;
  kind: MessageKind;
  body: string;
  senderRole: 'buyer' | 'seller' | 'system';
  senderName: string;
  /** Sent by the viewer personally. */
  mine: boolean;
  /** Sent from the viewer's side of the conversation (the viewer, or a colleague in the same shop). */
  fromViewerSide: boolean;
  createdAt: string;
  image: { url: string; thumbUrl: string } | null;
  offerId: string | null;
  hidden: boolean;
  /** Looks like an attempt to move payment/contact off-platform: show the checkout safety notice. */
  safetyFlag: boolean;
}

/**
 * Inserts a message and bumps the conversation's activity time. created_at uses clock_timestamp() so
 * several messages written in one transaction (e.g. an offer card and a system notice) keep their order.
 */
export async function insertMessage(
  tx: Queryable,
  args: { conversationId: string; senderUserId: string | null; kind: MessageKind; body?: string; mediaId?: string | null; offerId?: string | null },
): Promise<MessageRow> {
  const row = await one<MessageRow>(
    tx,
    `INSERT INTO messages (conversation_id, sender_user_id, kind, body, media_id, offer_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp()) RETURNING *`,
    [args.conversationId, args.senderUserId, args.kind, (args.body ?? '').slice(0, 2000), args.mediaId ?? null, args.offerId ?? null],
  );
  await tx.query(`UPDATE conversations SET last_message_at = greatest(last_message_at, $2) WHERE id = $1`, [args.conversationId, row.created_at]);
  return row;
}

/**
 * Posts a system notice (offer and order events) into a conversation. `actorUserId` is the person whose
 * action caused it (so it does not count as unread for them); null for worker-generated notices.
 */
export async function postSystemMessage(
  tx: Queryable,
  args: { conversationId: string; body: string; actorUserId?: string | null; offerId?: string | null },
): Promise<MessageRow> {
  return insertMessage(tx, { conversationId: args.conversationId, senderUserId: args.actorUserId ?? null, kind: 'system', body: args.body, offerId: args.offerId ?? null });
}

/**
 * Posts a system notice to every conversation linked to an order (for the fulfilment/disputes slices,
 * e.g. "Order TM100123 was dispatched."). Returns how many conversations received it.
 */
export async function postOrderSystemMessage(tx: Queryable, args: { orderId: string; body: string; actorUserId?: string | null }): Promise<number> {
  const convs = await many<{ id: string }>(tx, 'SELECT id FROM conversations WHERE order_id = $1', [args.orderId]);
  for (const c of convs) await postSystemMessage(tx, { conversationId: c.id, body: args.body, actorUserId: args.actorUserId ?? null });
  return convs.length;
}

/** Creates or reuses the single conversation for (listing, buyer). Safe under concurrent calls. */
export async function ensureListingConversation(
  tx: Queryable,
  args: { listingId: string; shopId: string; buyerUserId: string; orderId?: string | null },
): Promise<{ id: string; created: boolean }> {
  const inserted = await maybeOne<{ id: string }>(
    tx,
    `INSERT INTO conversations (shop_id, buyer_user_id, listing_id, order_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (listing_id, buyer_user_id) WHERE listing_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [args.shopId, args.buyerUserId, args.listingId, args.orderId ?? null],
  );
  if (inserted) return { id: inserted.id, created: true };
  const existing = await one<{ id: string }>(tx, 'SELECT id FROM conversations WHERE listing_id = $1 AND buyer_user_id = $2', [args.listingId, args.buyerUserId]);
  return { id: existing.id, created: false };
}

export interface MessageViewRow extends MessageRow {
  media_key: string | null;
  media_status: string | null;
  sender_display_name: string | null;
}

export const MESSAGE_VIEW_SELECT = `
  m.id, m.conversation_id, m.sender_user_id, m.kind, m.body, m.media_id, m.offer_id, m.hidden_at, m.created_at,
  ma.storage_key AS media_key, ma.status AS media_status, u.display_name AS sender_display_name`;
export const MESSAGE_VIEW_FROM = `
  messages m
  LEFT JOIN media_assets ma ON ma.id = m.media_id
  LEFT JOIN users u ON u.id = m.sender_user_id`;

export function toMessageView(
  ctx: AppContext,
  r: MessageViewRow,
  viewer: { userId: string; role: ConversationRole },
  conv: { buyerUserId: string; shopName: string },
): MessageView {
  const senderRole: MessageView['senderRole'] =
    r.kind === 'system' || r.sender_user_id === null ? 'system' : r.sender_user_id === conv.buyerUserId ? 'buyer' : 'seller';
  const hidden = r.hidden_at !== null;
  const senderName =
    senderRole === 'system' ? 'Thrift Market' : senderRole === 'buyer' ? (r.sender_display_name ?? 'Buyer') : conv.shopName;
  const image =
    !hidden && r.media_key && r.media_status === 'ready'
      ? { url: signMediaUrl(ctx, r.media_key, 900), thumbUrl: signMediaUrl(ctx, r.media_key, 900, 'thumb') }
      : null;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    kind: r.kind,
    body: hidden ? '' : r.body,
    senderRole,
    senderName,
    mine: r.sender_user_id !== null && r.sender_user_id === viewer.userId,
    fromViewerSide: senderRole === viewer.role,
    createdAt: new Date(r.created_at).toISOString(),
    image,
    offerId: r.offer_id,
    hidden,
    safetyFlag: !hidden && (r.kind === 'text' || r.kind === 'image' || r.kind === 'offer') && assessMessageSafety(r.body).flagged,
  };
}
