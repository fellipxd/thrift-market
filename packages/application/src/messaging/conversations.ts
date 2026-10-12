import {
  conversationIdInput,
  conversationMessagesQuery,
  listConversationsInput,
  sendMessageInput,
  startConversationInput,
  startOrderConversationInput,
} from '@thrift/contracts';
import { DomainError } from '@thrift/domain';
import { many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { requireOwnShop, requireUser, requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { withIdempotency } from '../core/idempotency';
import { enforceRateLimit } from '../core/rate-limit';
import { parseInput } from '../core/validation';
import { mediaPath } from '../media/media';
import { notifyUser } from '../notifications/notify';
import { offerThreadsForConversation, type OfferThreadView } from '../offers/queries';
import { assertNotBlocked, blockStateBetween, bumpListingStat, loadConversationAccess, shopMemberIds, type ConversationRole } from './access';
import { ensureListingConversation, insertMessage, MESSAGE_VIEW_FROM, MESSAGE_VIEW_SELECT, toMessageView, type MessageView, type MessageViewRow } from './messages';
import { spamFingerprint } from './safety';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same text sent into this many other conversations within an hour is treated as spam. */
const SPAM_CONVERSATION_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Starting conversations
// ---------------------------------------------------------------------------

/**
 * Opens (or reuses) the buyer's conversation about a listing. Works for available and reserved items, and for
 * sold items only when the caller bought one. New conversations are rate limited, more strictly for new accounts.
 */
export async function startConversation(ctx: AppContext, raw: unknown): Promise<{ conversationId: string; created: boolean }> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(startConversationInput, raw);
  const l = await maybeOne<{ id: string; status: string; shop_id: string; shop_status: string; is_member: boolean; bought: boolean }>(
    ctx.pool,
    `SELECT l.id, l.status, l.shop_id, s.status AS shop_status,
            EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = l.shop_id AND m.user_id = $2) AS is_member,
            EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                     WHERE oi.listing_id = l.id AND o.buyer_user_id = $2 AND o.status <> 'pending_payment') AS bought
       FROM listings l JOIN shops s ON s.id = l.shop_id WHERE l.id = $1`,
    [input.listingId, user.userId],
  );
  if (!l || l.status === 'draft' || l.status === 'removed' || l.shop_status === 'suspended') throw new DomainError('NOT_FOUND', 'Item not found.');
  if (l.is_member) throw new DomainError('FORBIDDEN', 'You can’t message your own shop.');
  const existing = await maybeOne<{ id: string }>(ctx.pool, 'SELECT id FROM conversations WHERE listing_id = $1 AND buyer_user_id = $2', [l.id, user.userId]);
  if (existing) return { conversationId: existing.id, created: false };
  if (!['active', 'reserved', 'scheduled'].includes(l.status) && !l.bought) {
    throw new DomainError('INVALID_STATE', 'This item is no longer available, so you can’t start a new conversation about it.');
  }
  await assertNotBlocked(ctx.pool, user.userId, l.shop_id, 'message this shop');
  const account = await one<{ new_account: boolean }>(ctx.pool, `SELECT created_at > now() - interval '1 day' AS new_account FROM users WHERE id = $1`, [user.userId]);
  await enforceRateLimit(
    ctx.pool,
    `conversation.start:${user.userId}`,
    account.new_account ? 3 : 10,
    3600,
    'You’ve started a lot of conversations recently. Please wait a while before messaging more sellers.',
  );
  const res = await withTransaction(ctx.pool, (tx) => ensureListingConversation(tx, { listingId: l.id, shopId: l.shop_id, buyerUserId: user.userId }));
  return { conversationId: res.id, created: res.created };
}

/** Opens the conversation for an order (buyer or a member of the selling shop). Links an existing listing conversation. */
export async function startOrderConversation(ctx: AppContext, raw: unknown): Promise<{ conversationId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(startOrderConversationInput, raw);
  const o = await maybeOne<{ id: string; shop_id: string; buyer_user_id: string; listing_id: string; is_member: boolean }>(
    ctx.pool,
    `SELECT o.id, o.shop_id, o.buyer_user_id, oi.listing_id,
            EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = o.shop_id AND m.user_id = $2) AS is_member
       FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.id = $1 ORDER BY oi.id LIMIT 1`,
    [input.orderId, user.userId],
  );
  if (!o || (o.buyer_user_id !== user.userId && !o.is_member)) throw new DomainError('NOT_FOUND', 'Order not found.');
  return withTransaction(ctx.pool, async (tx) => {
    const c = await ensureListingConversation(tx, { listingId: o.listing_id, shopId: o.shop_id, buyerUserId: o.buyer_user_id, orderId: o.id });
    if (!c.created) await tx.query(`UPDATE conversations SET order_id = $2 WHERE id = $1 AND order_id IS NULL`, [c.id, o.id]);
    return { conversationId: c.id };
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends a text and/or photo message. Participant-only, blocked in both directions, idempotent on the client key,
 * rate limited, with a simple cross-conversation duplicate-spam check. The other side is notified.
 */
export async function sendMessage(ctx: AppContext, raw: unknown): Promise<MessageView> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(sendMessageInput, raw);
  return withIdempotency(ctx.pool, { scope: 'message.send', actorId: user.userId, key: input.clientKey, request: input }, async () => {
    const access = await loadConversationAccess(ctx.pool, ctx, input.conversationId);
    const conv = access.conversation;
    await assertNotBlocked(ctx.pool, conv.buyer_user_id, conv.shop_id);
    await enforceRateLimit(ctx.pool, `message.minute:${user.userId}`, 20, 60, 'You’re sending messages too quickly. Wait a moment and try again.');
    await enforceRateLimit(ctx.pool, `message.day:${user.userId}`, 200, 86_400, 'You’ve reached today’s message limit. Try again tomorrow.');
    if (input.mediaId) {
      const media = await maybeOne<{ id: string }>(
        ctx.pool,
        `SELECT id FROM media_assets WHERE id = $1 AND owner_user_id = $2 AND purpose = 'message' AND status = 'ready'`,
        [input.mediaId, user.userId],
      );
      if (!media) throw new DomainError('VALIDATION_FAILED', 'That photo couldn’t be attached. Upload it again.', { fieldErrors: { mediaId: 'Upload the photo again.' } });
    }
    if (input.body.length >= 12) await assertNotSpam(ctx.pool, user.userId, conv.id, input.body);

    const shop = await one<{ name: string }>(ctx.pool, 'SELECT name FROM shops WHERE id = $1', [conv.shop_id]);
    return withTransaction(ctx.pool, async (tx) => {
      const row = await insertMessage(tx, {
        conversationId: conv.id,
        senderUserId: user.userId,
        kind: input.mediaId ? 'image' : 'text',
        body: input.body,
        mediaId: input.mediaId,
      });
      await tx.query(`UPDATE conversations SET status = 'open' WHERE id = $1 AND status = 'closed'`, [conv.id]);
      await markReadAt(tx, conv.id, user.userId, { messageId: row.id });
      if (conv.listing_id) await bumpListingStat(tx, conv.listing_id, 'messages');
      const recipients = access.role === 'buyer' ? await shopMemberIds(tx, conv.shop_id) : [conv.buyer_user_id];
      const preview = input.body ? (input.body.length > 80 ? `${input.body.slice(0, 77)}…` : input.body) : 'Sent a photo';
      for (const recipient of recipients.filter((id) => id !== user.userId)) {
        await notifyUser(tx, {
          userId: recipient,
          topic: 'messages',
          kind: 'message_received',
          title: access.role === 'buyer' ? `New message from ${user.displayName}` : `New message from ${shop.name}`,
          body: preview,
          link: `/inbox/${conv.id}`,
          dedupeKey: `msg:${row.id}`,
        });
      }
      const view = await one<MessageViewRow>(tx, `SELECT ${MESSAGE_VIEW_SELECT} FROM ${MESSAGE_VIEW_FROM} WHERE m.id = $1`, [row.id]);
      return toMessageView(ctx, view, { userId: user.userId, role: access.role }, { buyerUserId: conv.buyer_user_id, shopName: shop.name });
    });
  });
}

async function assertNotSpam(db: Queryable, userId: string, conversationId: string, body: string): Promise<void> {
  const fp = spamFingerprint(body);
  if (fp.length < 8) return;
  const recent = await many<{ conversation_id: string; body: string }>(
    db,
    `SELECT conversation_id, body FROM messages
      WHERE sender_user_id = $1 AND kind IN ('text','image') AND created_at > now() - interval '1 hour' AND conversation_id <> $2
      ORDER BY created_at DESC LIMIT 300`,
    [userId, conversationId],
  );
  const conversations = new Set(recent.filter((m) => spamFingerprint(m.body) === fp).map((m) => m.conversation_id));
  if (conversations.size >= SPAM_CONVERSATION_THRESHOLD) {
    throw new DomainError('RATE_LIMITED', 'You’ve sent this same message to many sellers in the last hour. Write to each seller about their item instead.');
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Moves the caller's read marker forward to a message (by id, so the database's microsecond timestamp is used —
 * JavaScript dates would truncate it) or to the current time.
 */
async function markReadAt(db: Queryable, conversationId: string, userId: string, through: { messageId: string } | 'now'): Promise<void> {
  await db.query(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at)
     VALUES ($1, $2, ${through === 'now' ? 'clock_timestamp()' : '(SELECT created_at FROM messages WHERE id = $3 AND conversation_id = $1)'})
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = greatest(conversation_reads.last_read_at, EXCLUDED.last_read_at)`,
    through === 'now' ? [conversationId, userId] : [conversationId, userId, through.messageId],
  );
}

/** Marks everything in the conversation as read for the caller (participants only). */
export async function markConversationRead(ctx: AppContext, raw: unknown): Promise<void> {
  const input = parseInput(conversationIdInput, raw);
  const access = await loadConversationAccess(ctx.pool, ctx, input.conversationId);
  await markReadAt(ctx.pool, access.conversation.id, access.userId, 'now');
}

export interface ConversationSummary {
  id: string;
  role: ConversationRole;
  counterpartName: string;
  listing: { id: string; title: string; photoUrl: string | null; priceMinor: number | null; status: string } | null;
  orderId: string | null;
  lastMessageAt: string;
  lastMessagePreview: string;
  unread: number;
  offerStatus: string | null;
}

/**
 * Unread messages for a viewer: newer than their read marker and not sent from their own side.
 * For sellers, messages from any shop member count as their own side.
 */
const UNREAD_SQL = (role: ConversationRole) => `(
  SELECT count(*)::int FROM messages um
   WHERE um.conversation_id = c.id AND um.hidden_at IS NULL
     AND um.created_at > coalesce((SELECT cr.last_read_at FROM conversation_reads cr WHERE cr.conversation_id = c.id AND cr.user_id = $1), '-infinity')
     AND ${
       role === 'buyer'
         ? 'um.sender_user_id IS DISTINCT FROM $1'
         : '(um.sender_user_id IS NULL OR um.sender_user_id NOT IN (SELECT sm.user_id FROM shop_members sm WHERE sm.shop_id = c.shop_id))'
     })`;

function decodeCursor(c: string | undefined): { at: string; id: string } | null {
  if (!c) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as [string, string];
    return !Number.isNaN(Date.parse(at)) && UUID.test(id) ? { at, id } : null;
  } catch {
    return null;
  }
}

/** Inbox list for the buyer side or the caller's shop, newest activity first, keyset paged. */
export async function listConversations(ctx: AppContext, raw: unknown = {}): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  const user = requireUser(ctx);
  const input = parseInput(listConversationsInput, raw);
  const role: ConversationRole = input.as;
  const shopId = role === 'seller' ? (await requireOwnShop(ctx.pool, ctx)).id : null;
  const cursor = decodeCursor(input.cursor);
  const params: unknown[] = [user.userId, role === 'buyer' ? user.userId : shopId, input.limit + 1];
  let keyset = '';
  if (cursor) {
    params.push(cursor.at, cursor.id);
    keyset = `AND (c.last_message_at, c.id) < ($4::timestamptz, $5::uuid)`;
  }
  const rows = await many<{
    id: string; last_message_at: Date; order_id: string | null; listing_id: string | null; title: string | null; price_minor: number | null; l_status: string | null;
    photo_key: string | null; counterpart: string; preview_kind: string | null; preview_body: string | null; preview_hidden: boolean | null; unread: number; offer_status: string | null;
  }>(
    ctx.pool,
    `SELECT c.id, c.last_message_at, c.order_id, c.listing_id, l.title, l.price_minor, l.status AS l_status,
            (SELECT ma.storage_key FROM listing_media lm JOIN media_assets ma ON ma.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key,
            ${role === 'buyer' ? 's.name' : 'u.display_name'} AS counterpart,
            lm.kind AS preview_kind, lm.body AS preview_body, lm.hidden_at IS NOT NULL AS preview_hidden,
            ${UNREAD_SQL(role)} AS unread,
            (SELECT t.status FROM offer_threads t WHERE t.conversation_id = c.id ORDER BY t.created_at DESC LIMIT 1) AS offer_status
       FROM conversations c
       JOIN shops s ON s.id = c.shop_id
       JOIN users u ON u.id = c.buyer_user_id
       LEFT JOIN listings l ON l.id = c.listing_id
       LEFT JOIN LATERAL (SELECT m.kind, m.body, m.hidden_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) lm ON true
      WHERE ${role === 'buyer' ? 'c.buyer_user_id = $2' : 'c.shop_id = $2'} ${keyset}
      ORDER BY c.last_message_at DESC, c.id DESC
      LIMIT $3`,
    params,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      role,
      counterpartName: r.counterpart,
      listing: r.listing_id
        ? { id: r.listing_id, title: r.title ?? 'Item', photoUrl: r.photo_key ? mediaPath(r.photo_key, 'thumb') : null, priceMinor: r.price_minor, status: r.l_status ?? 'ended' }
        : null,
      orderId: r.order_id,
      lastMessageAt: new Date(r.last_message_at).toISOString(),
      lastMessagePreview: previewText(r.preview_kind, r.preview_body, r.preview_hidden),
      unread: r.unread,
      offerStatus: r.offer_status,
    })),
    nextCursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify([new Date(last.last_message_at).toISOString(), last.id])).toString('base64url') : null,
  };
}

function previewText(kind: string | null, body: string | null, hidden: boolean | null): string {
  if (!kind) return 'No messages yet';
  if (hidden) return 'Message removed';
  if (kind === 'image' && !body) return 'Photo';
  if (kind === 'offer') return body || 'Offer';
  const b = body ?? '';
  return b.length > 90 ? `${b.slice(0, 87)}…` : b;
}

/** Total unread across the caller's buying conversations and their shop's conversations (header badge). */
export async function inboxUnreadCount(ctx: AppContext): Promise<number> {
  if (ctx.actor.kind !== 'user') return 0;
  const userId = ctx.actor.userId;
  const r = await one<{ n: number }>(
    ctx.pool,
    `SELECT coalesce(sum(CASE WHEN c.buyer_user_id = $1 THEN ${UNREAD_SQL('buyer')} ELSE ${UNREAD_SQL('seller')} END), 0)::int AS n
       FROM conversations c
      WHERE c.buyer_user_id = $1 OR c.shop_id IN (SELECT shop_id FROM shop_members WHERE user_id = $1)`,
    [userId],
  );
  return r.n;
}

export interface ConversationDetail {
  id: string;
  role: ConversationRole;
  viewerUserId: string;
  shop: { id: string; name: string; slug: string };
  buyerName: string;
  counterpartName: string;
  listing: {
    id: string; title: string; photoUrl: string | null; priceMinor: number | null; status: string; saleMode: string; available: number; negotiable: boolean;
  } | null;
  order: { id: string; number: string; status: string } | null;
  messages: MessageView[];
  hasOlder: boolean;
  offerThreads: OfferThreadView[];
  block: { blocked: boolean; byViewer: boolean };
  serverNow: string;
}

const PAGE_SIZE = 100;

/** A conversation for one of its participants: context, latest messages, offer threads and block state. */
export async function getConversation(ctx: AppContext, conversationId: string, opts: { before?: string } = {}): Promise<ConversationDetail> {
  if (!UUID.test(conversationId)) throw new DomainError('NOT_FOUND', 'Conversation not found.');
  const access = await loadConversationAccess(ctx.pool, ctx, conversationId);
  const conv = access.conversation;
  const ctxRow = await one<{
    shop_name: string; shop_slug: string; buyer_name: string; title: string | null; price_minor: number | null; l_status: string | null; sale_mode: string | null;
    available: number | null; photo_key: string | null; order_number: string | null; order_status: string | null;
  }>(
    ctx.pool,
    `SELECT s.name AS shop_name, s.slug AS shop_slug, u.display_name AS buyer_name, l.title, l.price_minor, l.status AS l_status, l.sale_mode,
            st.quantity_available AS available,
            (SELECT ma.storage_key FROM listing_media lm JOIN media_assets ma ON ma.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key,
            o.number AS order_number, o.status AS order_status
       FROM conversations c JOIN shops s ON s.id = c.shop_id JOIN users u ON u.id = c.buyer_user_id
       LEFT JOIN listings l ON l.id = c.listing_id LEFT JOIN inventory_stock st ON st.listing_id = l.id
       LEFT JOIN orders o ON o.id = c.order_id
      WHERE c.id = $1`,
    [conv.id],
  );
  const before = messageBoundary(opts.before, 3, 'before');
  const rows = await many<MessageViewRow>(
    ctx.pool,
    `SELECT * FROM (
       SELECT ${MESSAGE_VIEW_SELECT} FROM ${MESSAGE_VIEW_FROM}
        WHERE m.conversation_id = $1 ${before ? `AND m.created_at < ${before.sql}` : ''}
        ORDER BY m.created_at DESC LIMIT $2) x
     ORDER BY created_at`,
    before ? [conv.id, PAGE_SIZE + 1, before.value] : [conv.id, PAGE_SIZE + 1],
  );
  const hasOlder = rows.length > PAGE_SIZE;
  const visible = hasOlder ? rows.slice(1) : rows;
  const viewer = { userId: access.userId, role: access.role };
  const convInfo = { buyerUserId: conv.buyer_user_id, shopName: ctxRow.shop_name };
  const block = await blockStateBetween(ctx.pool, conv.buyer_user_id, conv.shop_id);
  const byViewer = access.role === 'buyer' ? block.byBuyer : await viewerBlockedBuyer(ctx.pool, access.userId, conv.buyer_user_id);
  return {
    id: conv.id,
    role: access.role,
    viewerUserId: access.userId,
    shop: { id: conv.shop_id, name: ctxRow.shop_name, slug: ctxRow.shop_slug },
    buyerName: ctxRow.buyer_name,
    counterpartName: access.role === 'buyer' ? ctxRow.shop_name : ctxRow.buyer_name,
    listing: conv.listing_id
      ? {
          id: conv.listing_id,
          title: ctxRow.title ?? 'Item',
          photoUrl: ctxRow.photo_key ? mediaPath(ctxRow.photo_key, 'thumb') : null,
          priceMinor: ctxRow.price_minor,
          status: ctxRow.l_status ?? 'ended',
          saleMode: ctxRow.sale_mode ?? 'fixed',
          available: ctxRow.available ?? 0,
          negotiable: ctxRow.sale_mode === 'negotiable',
        }
      : null,
    order: conv.order_id && ctxRow.order_number ? { id: conv.order_id, number: ctxRow.order_number, status: ctxRow.order_status ?? '' } : null,
    messages: visible.map((r) => toMessageView(ctx, r, viewer, convInfo)),
    hasOlder,
    offerThreads: await offerThreadsForConversation(ctx.pool, conv.id, { role: access.role, now: ctx.now() }),
    block: { blocked: block.blocked, byViewer },
    serverNow: ctx.now().toISOString(),
  };
}

async function viewerBlockedBuyer(db: Queryable, viewerId: string, buyerId: string): Promise<boolean> {
  return (await maybeOne(db, 'SELECT 1 AS ok FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2', [viewerId, buyerId])) !== null;
}

/**
 * `after` / `before` accept the id of a message in this conversation (exact) or an ISO timestamp. Returns a SQL
 * expression for the boundary using parameter `$n` (conversation id must be `$1`), or null when unusable.
 */
function messageBoundary(ref: string | undefined, n: number, edge: 'after' | 'before'): { sql: string; value: string } | null {
  if (!ref) return null;
  if (UUID.test(ref)) {
    return { sql: `coalesce((SELECT created_at FROM messages WHERE id = $${n} AND conversation_id = $1), '${edge === 'after' ? '-infinity' : 'infinity'}'::timestamptz)`, value: ref };
  }
  return Number.isNaN(Date.parse(ref)) ? null : { sql: `$${n}::timestamptz`, value: new Date(ref).toISOString() };
}

/** Polling: messages newer than `after`, current offer state and server time. Marks them read. */
export async function conversationUpdates(
  ctx: AppContext,
  conversationId: string,
  raw: unknown = {},
): Promise<{ messages: MessageView[]; offerThreads: OfferThreadView[]; block: { blocked: boolean }; serverNow: string }> {
  if (!UUID.test(conversationId)) throw new DomainError('NOT_FOUND', 'Conversation not found.');
  const q = parseInput(conversationMessagesQuery, raw);
  const access = await loadConversationAccess(ctx.pool, ctx, conversationId);
  const conv = access.conversation;
  const after = messageBoundary(q.after, 2, 'after');
  const shop = await one<{ name: string }>(ctx.pool, 'SELECT name FROM shops WHERE id = $1', [conv.shop_id]);
  const rows = await many<MessageViewRow>(
    ctx.pool,
    `SELECT ${MESSAGE_VIEW_SELECT} FROM ${MESSAGE_VIEW_FROM}
      WHERE m.conversation_id = $1 ${after ? `AND m.created_at > ${after.sql}` : ''}
      ORDER BY m.created_at LIMIT 200`,
    after ? [conv.id, after.value] : [conv.id],
  );
  if (rows.length) await markReadAt(ctx.pool, conv.id, access.userId, { messageId: rows[rows.length - 1]!.id });
  const block = await blockStateBetween(ctx.pool, conv.buyer_user_id, conv.shop_id);
  return {
    messages: rows.map((r) => toMessageView(ctx, r, { userId: access.userId, role: access.role }, { buyerUserId: conv.buyer_user_id, shopName: shop.name })),
    offerThreads: await offerThreadsForConversation(ctx.pool, conv.id, { role: access.role, now: ctx.now() }),
    block: { blocked: block.blocked },
    serverNow: ctx.now().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/**
 * Blocks the other side of a conversation. A buyer blocks the whole shop (every member); a seller blocks the buyer.
 * Blocks stop messages and offers in both directions until removed by whoever created them.
 */
export async function blockConversationParty(ctx: AppContext, raw: unknown): Promise<{ blocked: true }> {
  const input = parseInput(conversationIdInput, raw);
  const access = await loadConversationAccess(ctx.pool, ctx, input.conversationId);
  const targets = access.role === 'buyer' ? await shopMemberIds(ctx.pool, access.conversation.shop_id) : [access.conversation.buyer_user_id];
  await withTransaction(ctx.pool, async (tx) => {
    for (const t of targets.filter((id) => id !== access.userId)) {
      await tx.query(`INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [access.userId, t]);
    }
    await tx.query(
      `INSERT INTO audit_events (actor_user_id, actor_kind, action, target_kind, target_id, data) VALUES ($1, 'user', 'conversation.blocked', 'conversation', $2, $3)`,
      [access.userId, access.conversation.id, JSON.stringify({ role: access.role })],
    );
  });
  return { blocked: true };
}

export async function unblockConversationParty(ctx: AppContext, raw: unknown): Promise<{ blocked: boolean }> {
  const input = parseInput(conversationIdInput, raw);
  const access = await loadConversationAccess(ctx.pool, ctx, input.conversationId);
  const targets = access.role === 'buyer' ? await shopMemberIds(ctx.pool, access.conversation.shop_id) : [access.conversation.buyer_user_id];
  await ctx.pool.query(`DELETE FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = ANY($2::uuid[])`, [access.userId, targets]);
  const state = await blockStateBetween(ctx.pool, access.conversation.buyer_user_id, access.conversation.shop_id);
  return { blocked: state.blocked };
}
