import { bagItemInput, bagRemoveInput } from '@thrift/contracts';
import { CONDITION_INFO, DomainError, type ConditionGrade } from '@thrift/domain';
import { many, maybeOne, one } from '@thrift/database';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { mediaPath } from '../media/media';

/**
 * The bag (doc 06 "cart") is an editable interest list. It never holds stock: anyone can buy a piece in your bag
 * until your checkout holds it. Checkout is per shop (same seller only), and holds every piece or none.
 */

export type BagItemState = 'available' | 'held_for_you' | 'reserved' | 'sold' | 'unavailable';

export interface BagItem {
  listingId: string;
  title: string;
  photoUrl: string | null;
  conditionLabel: string | null;
  sizeLabel: string | null;
  quantityMode: 'unique' | 'equivalent';
  /** Quantity saved, capped to what is available now. */
  quantity: number;
  quantityAvailable: number;
  unitPriceMinor: number | null;
  addedPriceMinor: number | null;
  priceChanged: boolean;
  state: BagItemState;
  /** Unpaid order of yours that holds this piece (state held_for_you). */
  pendingOrderId: string | null;
}

export interface BagShopGroup {
  shop: { id: string; name: string; slug: string; city: string; state: string };
  items: BagItem[];
  /** Pieces a checkout would include now (available ones). */
  checkoutable: BagItem[];
  subtotalMinor: number;
  /** Why this shop's pieces can't be checked out right now. */
  blocked: string | null;
}

export interface BagView {
  groups: BagShopGroup[];
  count: number;
  maxItems: number;
}

interface BagRow {
  listing_id: string;
  quantity: number;
  added_price_minor: number | null;
  title: string;
  status: string;
  sale_mode: string;
  quantity_mode: 'unique' | 'equivalent';
  price_minor: number | null;
  condition: ConditionGrade | null;
  size_label: string | null;
  shop_id: string;
  shop_name: string;
  shop_slug: string;
  shop_status: string;
  shop_city: string;
  shop_state: string;
  quantity_available: number | null;
  photo_key: string | null;
  my_order_id: string | null;
  is_member: boolean;
  [k: string]: unknown;
}

function itemState(r: BagRow): BagItemState {
  if (r.my_order_id) return 'held_for_you';
  if (r.status === 'sold') return 'sold';
  if (r.status === 'reserved') return 'reserved';
  if (r.status !== 'active' || !['fixed', 'negotiable'].includes(r.sale_mode) || !r.price_minor || r.shop_status !== 'active') return 'unavailable';
  if ((r.quantity_available ?? 0) < 1) return 'reserved';
  return 'available';
}

async function bagRows(ctx: AppContext, userId: string, shopId?: string): Promise<BagRow[]> {
  return many<BagRow>(
    ctx.pool,
    `SELECT b.listing_id, b.quantity, b.added_price_minor, l.title, l.status, l.sale_mode, l.quantity_mode, l.price_minor, l.condition, l.size_label,
            s.id AS shop_id, s.name AS shop_name, s.slug AS shop_slug, s.status AS shop_status, s.city AS shop_city, s.state AS shop_state,
            st.quantity_available,
            (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key,
            (SELECT o.id FROM reservations r JOIN order_items oi ON oi.reservation_id = r.id JOIN orders o ON o.id = oi.order_id
              WHERE r.listing_id = l.id AND r.buyer_user_id = $1 AND r.status IN ('active','payment_pending') AND o.status = 'pending_payment'
              ORDER BY o.created_at DESC LIMIT 1) AS my_order_id,
            EXISTS (SELECT 1 FROM shop_members sm WHERE sm.shop_id = s.id AND sm.user_id = $1) AS is_member
       FROM bag_items b JOIN listings l ON l.id = b.listing_id JOIN shops s ON s.id = l.shop_id LEFT JOIN inventory_stock st ON st.listing_id = l.id
      WHERE b.user_id = $1 ${shopId ? 'AND s.id = $2' : ''}
      ORDER BY b.created_at DESC, b.listing_id`,
    shopId ? [userId, shopId] : [userId],
  );
}

function toGroups(rows: BagRow[]): BagShopGroup[] {
  const groups = new Map<string, BagShopGroup & { member: boolean; shopActive: boolean }>();
  for (const r of rows) {
    let g = groups.get(r.shop_id);
    if (!g) {
      g = {
        shop: { id: r.shop_id, name: r.shop_name, slug: r.shop_slug, city: r.shop_city, state: r.shop_state },
        items: [],
        checkoutable: [],
        subtotalMinor: 0,
        blocked: null,
        member: r.is_member,
        shopActive: r.shop_status === 'active',
      };
      groups.set(r.shop_id, g);
    }
    const state = itemState(r);
    const available = r.quantity_available ?? 0;
    const item: BagItem = {
      listingId: r.listing_id,
      title: r.title,
      photoUrl: r.photo_key ? mediaPath(r.photo_key, 'thumb') : null,
      conditionLabel: r.condition ? CONDITION_INFO[r.condition].label : null,
      sizeLabel: r.size_label,
      quantityMode: r.quantity_mode,
      quantity: r.quantity_mode === 'unique' ? 1 : Math.max(1, Math.min(r.quantity, available || r.quantity)),
      quantityAvailable: available,
      unitPriceMinor: r.price_minor,
      addedPriceMinor: r.added_price_minor,
      priceChanged: r.added_price_minor !== null && r.price_minor !== null && r.added_price_minor !== r.price_minor,
      state,
      pendingOrderId: r.my_order_id,
    };
    g.items.push(item);
    if (state === 'available') {
      g.checkoutable.push(item);
      g.subtotalMinor += (item.unitPriceMinor ?? 0) * item.quantity;
    }
  }
  return [...groups.values()].map(({ member, shopActive, ...g }) => ({
    ...g,
    blocked: member
      ? 'You can’t buy from your own shop.'
      : !shopActive
        ? 'This shop isn’t taking orders right now.'
        : g.checkoutable.length === 0
          ? 'None of these pieces can be bought right now.'
          : null,
  }));
}

export async function getBag(ctx: AppContext): Promise<BagView> {
  const user = requireUser(ctx);
  const settings = await getSettings(ctx.pool);
  const rows = await bagRows(ctx, user.userId);
  return { groups: toGroups(rows), count: rows.length, maxItems: settings.max_bag_items };
}

/** One shop's part of the bag (what a bag checkout from that shop starts from). */
export async function getBagGroup(ctx: AppContext, shopId: string): Promise<BagShopGroup | null> {
  const user = requireUser(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(shopId)) return null;
  return toGroups(await bagRows(ctx, user.userId, shopId))[0] ?? null;
}

/** Pieces in the shopper's bag (0 when signed out). */
export async function bagCount(ctx: AppContext): Promise<number> {
  if (!ctx.actor || ctx.actor.kind !== 'user') return 0;
  const r = await one<{ n: number }>(ctx.pool, 'SELECT count(*)::int AS n FROM bag_items WHERE user_id = $1', [ctx.actor.userId]);
  return r.n;
}

export async function isInBag(ctx: AppContext, listingId: string): Promise<boolean> {
  if (!ctx.actor || ctx.actor.kind !== 'user' || !/^[0-9a-f-]{36}$/i.test(listingId)) return false;
  return !!(await maybeOne(ctx.pool, 'SELECT 1 AS ok FROM bag_items WHERE user_id = $1 AND listing_id = $2', [ctx.actor.userId, listingId]));
}

/**
 * Saves a piece to the bag, or changes its quantity. Only pieces you could buy at a fixed price right now can be
 * added; adding never reserves anything.
 */
export async function saveToBag(ctx: AppContext, raw: unknown): Promise<{ count: number; quantity: number }> {
  const user = requireUser(ctx);
  const input = parseInput(bagItemInput, raw);
  await enforceRateLimit(ctx.pool, `bag:${user.userId}`, 200, 3600, 'Too many bag changes. Wait a few minutes and try again.');
  const settings = await getSettings(ctx.pool);
  const l = await maybeOne<{
    id: string; status: string; sale_mode: string; quantity_mode: 'unique' | 'equivalent'; price_minor: number | null; shop_status: string;
    quantity_available: number | null; is_member: boolean; [k: string]: unknown;
  }>(
    ctx.pool,
    `SELECT l.id, l.status, l.sale_mode, l.quantity_mode, l.price_minor, s.status AS shop_status, st.quantity_available,
            EXISTS (SELECT 1 FROM shop_members sm WHERE sm.shop_id = s.id AND sm.user_id = $2) AS is_member
       FROM listings l JOIN shops s ON s.id = l.shop_id LEFT JOIN inventory_stock st ON st.listing_id = l.id WHERE l.id = $1`,
    [input.listingId, user.userId],
  );
  if (!l || !['active', 'reserved', 'sold'].includes(l.status)) throw new DomainError('NOT_FOUND', 'This piece isn’t available.');
  if (l.is_member) throw new DomainError('FORBIDDEN', 'You can’t add pieces from your own shop.');
  if (l.sale_mode === 'auction') throw new DomainError('INVALID_STATE', 'Auction pieces are bought by bidding, not from the bag.');
  if (!['fixed', 'negotiable'].includes(l.sale_mode) || !l.price_minor) throw new DomainError('INVALID_STATE', 'This piece can’t be bought at a fixed price.');
  if (l.shop_status !== 'active') throw new DomainError('INVALID_STATE', 'This shop isn’t taking orders right now.');
  const available = l.quantity_available ?? 0;
  if (l.status !== 'active' || available < 1) throw new DomainError('STOCK_CONFLICT', l.status === 'sold' ? 'This piece has sold.' : 'This piece is on hold for another buyer right now.');
  const quantity = l.quantity_mode === 'unique' ? 1 : Math.min(input.quantity, available);
  const others = await one<{ n: number }>(ctx.pool, 'SELECT count(*)::int AS n FROM bag_items WHERE user_id = $1 AND listing_id <> $2', [user.userId, l.id]);
  if (others.n >= settings.max_bag_items) throw new DomainError('RATE_LIMITED', `Your bag can hold ${settings.max_bag_items} pieces. Remove some to add more.`);
  await ctx.pool.query(
    `INSERT INTO bag_items (user_id, listing_id, quantity, added_price_minor) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, listing_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
    [user.userId, l.id, quantity, l.price_minor],
  );
  return { count: others.n + 1, quantity };
}

export async function removeFromBag(ctx: AppContext, raw: unknown): Promise<{ count: number }> {
  const user = requireUser(ctx);
  const input = parseInput(bagRemoveInput, raw);
  await ctx.pool.query('DELETE FROM bag_items WHERE user_id = $1 AND listing_id = $2', [user.userId, input.listingId]);
  return { count: await bagCount(ctx) };
}
