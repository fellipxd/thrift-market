import { savedItemsInput } from '@thrift/contracts';
import { many, one } from '@thrift/database';
import { LISTING_CARD_FROM, type ListingCardRow } from '../catalogue/cards';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { DISCOVERY_CARD_COLUMNS, toDiscoveryCard, type DiscoveryCard } from './cards';
import { decodeCursor, encodeCursor, filterHash } from './cursor';
import { shopSummaryColumns, toShopSummary, type ShopSummary, type ShopSummaryRow } from './shops';
import { publicListingSql, PUBLISHED_AT_SQL, SqlParams, timestampKeySql } from './sql';

export type UnavailableReason = 'sold' | 'auction_ended' | 'ended' | 'removed' | 'not_available';

export const UNAVAILABLE_REASON_LABEL: Record<UnavailableReason, string> = {
  sold: 'Sold',
  auction_ended: 'Auction ended',
  ended: 'No longer listed',
  removed: 'Removed from the marketplace',
  not_available: 'Not available right now',
};

export interface SavedUnavailableItem extends DiscoveryCard {
  unavailableReason: UnavailableReason;
  unavailableLabel: string;
}

export interface SavedItemsResult {
  available: DiscoveryCard[];
  nextCursor: string | null;
  /** Saved items that sold or became unavailable (first page only, most recently saved first). */
  unavailable: SavedUnavailableItem[];
  unavailableCount: number;
  serverNow: string;
}

type KeyedRow = ListingCardRow & { sort_key: string };

const UNAVAILABLE_SHOWN = 24;

/**
 * The caller's saved items (R21 read side). Only the signed-in user's own rows are ever read. Available items are
 * paginated by save time; items that sold or became unavailable are grouped separately. Removed listings and
 * listings of suspended shops are shown without their photo.
 */
export async function savedItems(ctx: AppContext, raw: unknown = {}): Promise<SavedItemsResult> {
  const user = requireUser(ctx);
  const input = parseInput(savedItemsInput, raw ?? {});
  const now = ctx.now();
  const hash = filterHash({ saved: user.userId });

  const p = new SqlParams();
  const nowParam = p.add(now, 'timestamptz');
  const userParam = p.add(user.userId, 'uuid');
  const where = [publicListingSql(nowParam)];
  if (input.cursor) {
    const c = decodeCursor(input.cursor, { sort: 'saved', filters: hash, kinds: ['ts'] });
    where.push(`(si.created_at, l.id) < (${p.add(c.keys[0], 'timestamptz')}, ${p.add(c.id, 'uuid')})`);
  }
  const availableSql = `SELECT ${DISCOVERY_CARD_COLUMNS}, ${timestampKeySql('si.created_at')} AS sort_key
      FROM ${LISTING_CARD_FROM}
      JOIN saved_items si ON si.listing_id = l.id AND si.user_id = ${userParam}
     WHERE ${where.join(' AND ')}
     ORDER BY si.created_at DESC, l.id DESC
     LIMIT ${p.add(input.limit + 1, 'int')}`;

  const unavailableQuery = async () => {
    const up = new SqlParams();
    const nowU = up.add(now, 'timestamptz');
    const userU = up.add(user.userId, 'uuid');
    const notPublic = `NOT coalesce(${publicListingSql(nowU)}, false)`;
    const [rows, count] = await Promise.all([
      many<ListingCardRow & { shop_status: string }>(
        ctx.pool,
        `SELECT ${DISCOVERY_CARD_COLUMNS}, s.status AS shop_status
           FROM ${LISTING_CARD_FROM}
           JOIN saved_items si ON si.listing_id = l.id AND si.user_id = ${userU}
          WHERE ${notPublic}
          ORDER BY si.created_at DESC, l.id DESC
          LIMIT ${UNAVAILABLE_SHOWN}`,
        up.values,
      ),
      one<{ n: number }>(
        ctx.pool,
        `SELECT count(*)::int AS n FROM ${LISTING_CARD_FROM}
           JOIN saved_items si ON si.listing_id = l.id AND si.user_id = ${userU}
          WHERE ${notPublic}`,
        up.values,
      ),
    ]);
    return { rows, count: count.n };
  };

  const [rows, unavailable] = await Promise.all([
    many<KeyedRow>(ctx.pool, availableSql, p.values),
    input.cursor ? Promise.resolve({ rows: [], count: 0 }) : unavailableQuery(),
  ]);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    available: page.map((r) => toDiscoveryCard(r)),
    nextCursor: rows.length > input.limit && last ? encodeCursor({ sort: 'saved', filters: hash, keys: [last.sort_key], id: last.id }) : null,
    unavailable: unavailable.rows.map((r) => toUnavailable(r, now)),
    unavailableCount: unavailable.count,
    serverNow: now.toISOString(),
  };
}

function toUnavailable(r: ListingCardRow & { shop_status: string }, now: Date): SavedUnavailableItem {
  let reason: UnavailableReason = 'not_available';
  if (r.status === 'removed') reason = 'removed';
  else if (r.status === 'sold') reason = 'sold';
  else if (r.sale_mode === 'auction' && (r.status === 'ended' || !['scheduled', 'live'].includes(r.auction_status ?? '') || (r.auction_ends_at && new Date(r.auction_ends_at) <= now)))
    reason = 'auction_ended';
  else if (r.status === 'ended') reason = 'ended';
  const card = toDiscoveryCard(r);
  const hidePhoto = reason === 'removed' || r.shop_status === 'suspended';
  return {
    ...card,
    photoKey: hidePhoto ? null : card.photoKey,
    unavailableReason: reason,
    unavailableLabel: UNAVAILABLE_REASON_LABEL[reason],
  };
}

export interface FollowedShop extends ShopSummary {
  /** False when the shop is paused or suspended (not taking new orders). */
  selling: boolean;
  followedAt: string;
  latest: DiscoveryCard[];
}

const FOLLOWED_MAX = 100;
const FOLLOWED_LATEST_PER_SHOP = 4;

/** Shops the caller follows, newest follow first, each with its latest public items (R21 read side). */
export async function followedShops(ctx: AppContext): Promise<FollowedShop[]> {
  const user = requireUser(ctx);
  const now = ctx.now();
  const p = new SqlParams();
  const nowParam = p.add(now, 'timestamptz');
  const shops = await many<ShopSummaryRow & { followed_at: Date }>(
    ctx.pool,
    `SELECT ${shopSummaryColumns(nowParam)}, f.created_at AS followed_at
       FROM follows f
       JOIN shops s ON s.id = f.shop_id
       LEFT JOIN delivery_coverage dc ON dc.shop_id = s.id
      WHERE f.user_id = ${p.add(user.userId, 'uuid')} AND s.status IN ('active','paused','suspended')
      ORDER BY f.created_at DESC, s.id
      LIMIT ${FOLLOWED_MAX}`,
    p.values,
  );
  if (shops.length === 0) return [];
  const lp = new SqlParams();
  const latest = await many<ListingCardRow & { rn: number }>(
    ctx.pool,
    `SELECT * FROM (
        SELECT ${DISCOVERY_CARD_COLUMNS},
               row_number() OVER (PARTITION BY l.shop_id ORDER BY ${PUBLISHED_AT_SQL} DESC, l.id DESC) AS rn
          FROM ${LISTING_CARD_FROM}
         WHERE ${publicListingSql(lp.add(now, 'timestamptz'))} AND l.shop_id = ANY(${lp.add(
           shops.map((s) => s.id),
           'uuid[]',
         )})
      ) x WHERE x.rn <= ${FOLLOWED_LATEST_PER_SHOP}`,
    lp.values,
  );
  const byShop = new Map<string, DiscoveryCard[]>();
  for (const r of latest) {
    const list = byShop.get(r.shop_id) ?? [];
    list.push(toDiscoveryCard(r));
    byShop.set(r.shop_id, list);
  }
  return shops.map((s) => ({
    ...toShopSummary(s),
    selling: s.shop_status === 'active',
    followedAt: new Date(s.followed_at).toISOString(),
    latest: s.shop_status === 'active' ? (byShop.get(s.id) ?? []) : [],
  }));
}

export interface FollowedItemsResult {
  items: DiscoveryCard[];
  nextCursor: string | null;
}

/** Latest public listings from shops the caller follows ("Fresh from sellers you follow"), keyset by newest. */
export async function followedShopsNewItems(ctx: AppContext, raw: unknown = {}): Promise<FollowedItemsResult> {
  const user = requireUser(ctx);
  const input = parseInput(savedItemsInput, raw ?? {});
  const hash = filterHash({ following: user.userId });
  const p = new SqlParams();
  const where = [publicListingSql(p.add(ctx.now(), 'timestamptz'))];
  if (input.cursor) {
    const c = decodeCursor(input.cursor, { sort: 'following', filters: hash, kinds: ['ts'] });
    where.push(`(${PUBLISHED_AT_SQL}, l.id) < (${p.add(c.keys[0], 'timestamptz')}, ${p.add(c.id, 'uuid')})`);
  }
  const rows = await many<KeyedRow>(
    ctx.pool,
    `SELECT ${DISCOVERY_CARD_COLUMNS}, ${timestampKeySql(PUBLISHED_AT_SQL)} AS sort_key
       FROM ${LISTING_CARD_FROM}
       JOIN follows f ON f.shop_id = s.id AND f.user_id = ${p.add(user.userId, 'uuid')}
      WHERE ${where.join(' AND ')}
      ORDER BY ${PUBLISHED_AT_SQL} DESC, l.id DESC
      LIMIT ${p.add(input.limit + 1, 'int')}`,
    p.values,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toDiscoveryCard(r)),
    nextCursor: rows.length > input.limit && last ? encodeCursor({ sort: 'following', filters: hash, keys: [last.sort_key], id: last.id }) : null,
  };
}
