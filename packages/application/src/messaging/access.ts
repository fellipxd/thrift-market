import { DomainError } from '@thrift/domain';
import { many, maybeOne, type Queryable } from '@thrift/database';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';

export type ConversationRole = 'buyer' | 'seller';

export interface ConversationRow {
  id: string;
  shop_id: string;
  buyer_user_id: string;
  listing_id: string | null;
  order_id: string | null;
  status: 'open' | 'closed' | 'blocked';
  last_message_at: Date;
  created_at: Date;
  [k: string]: unknown;
}

export interface ConversationAccess {
  conversation: ConversationRow;
  role: ConversationRole;
  userId: string;
}

/**
 * Object-level access check for a conversation: the caller is its buyer or a member of its shop.
 * Anyone else (including other sellers and staff) gets NOT_FOUND so ids cannot be probed.
 */
export async function loadConversationAccess(
  db: Queryable,
  ctx: AppContext,
  conversationId: string,
  opts: { lock?: boolean } = {},
): Promise<ConversationAccess> {
  const user = requireUser(ctx);
  const row = await maybeOne<ConversationRow & { is_member: boolean }>(
    db,
    `SELECT c.*, EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = c.shop_id AND m.user_id = $2) AS is_member
       FROM conversations c WHERE c.id = $1 ${opts.lock ? 'FOR UPDATE OF c' : ''}`,
    [conversationId, user.userId],
  );
  if (!row) throw new DomainError('NOT_FOUND', 'Conversation not found.');
  const { is_member, ...conversation } = row;
  if (conversation.buyer_user_id === user.userId) return { conversation, role: 'buyer', userId: user.userId };
  if (is_member) return { conversation, role: 'seller', userId: user.userId };
  throw new DomainError('NOT_FOUND', 'Conversation not found.');
}

export async function shopMemberIds(db: Queryable, shopId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(db, 'SELECT user_id FROM shop_members WHERE shop_id = $1 ORDER BY role = $2 DESC, created_at', [shopId, 'owner']);
  return rows.map((r) => r.user_id);
}

export async function isShopMember(db: Queryable, shopId: string, userId: string): Promise<boolean> {
  const row = await maybeOne(db, 'SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2', [shopId, userId]);
  return row !== null;
}

export interface BlockState {
  /** True when either side has blocked the other: nobody can send messages or offers. */
  blocked: boolean;
  /** The buyer blocked the shop. */
  byBuyer: boolean;
  /** A member of the shop blocked the buyer. */
  byShop: boolean;
}

/**
 * Blocks are user-to-user rows. Between a buyer and a shop they apply in both directions: the buyer
 * blocking any shop member, or any shop member blocking the buyer, stops messaging and offers.
 */
export async function blockStateBetween(db: Queryable, buyerUserId: string, shopId: string): Promise<BlockState> {
  const row = await maybeOne<{ by_buyer: boolean; by_shop: boolean }>(
    db,
    `SELECT
       EXISTS (SELECT 1 FROM user_blocks b JOIN shop_members m ON m.user_id = b.blocked_user_id
                WHERE b.blocker_user_id = $1 AND m.shop_id = $2) AS by_buyer,
       EXISTS (SELECT 1 FROM user_blocks b JOIN shop_members m ON m.user_id = b.blocker_user_id
                WHERE b.blocked_user_id = $1 AND m.shop_id = $2) AS by_shop`,
    [buyerUserId, shopId],
  );
  const byBuyer = row?.by_buyer ?? false;
  const byShop = row?.by_shop ?? false;
  return { blocked: byBuyer || byShop, byBuyer, byShop };
}

export async function assertNotBlocked(db: Queryable, buyerUserId: string, shopId: string, what = 'send messages'): Promise<void> {
  const state = await blockStateBetween(db, buyerUserId, shopId);
  if (state.blocked) {
    throw new DomainError('FORBIDDEN', `You can't ${what} here because one of you has blocked the other.`);
  }
}

/** Analytics counter (rebuildable, never business truth). Day is the West Africa Time calendar date. */
export async function bumpListingStat(db: Queryable, listingId: string, field: 'messages' | 'offers'): Promise<void> {
  await db.query(
    `INSERT INTO listing_daily_stats (listing_id, day, ${field})
     VALUES ($1, (now() AT TIME ZONE 'Africa/Lagos')::date, 1)
     ON CONFLICT (listing_id, day) DO UPDATE SET ${field} = listing_daily_stats.${field} + 1`,
    [listingId],
  );
}
