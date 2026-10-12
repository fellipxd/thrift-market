import { computeOrderTotals, CONDITION_INFO, DomainError, type ConditionGrade, type DeliveryOption } from '@thrift/domain';
import { many, maybeOne, one } from '@thrift/database';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { listAddresses, type AddressView } from '../addresses/addresses';
import { quoteDeliveryOptions } from '../delivery/quote';
import { mediaPath } from '../media/media';

export interface CheckoutOption extends DeliveryOption {
  totals: { itemsTotalMinor: number; shippingMinor: number; buyerFeeMinor: number; totalMinor: number };
}

export interface CheckoutContext {
  mode: 'listing' | 'reservation';
  listing: {
    id: string;
    title: string;
    photoUrl: string | null;
    shopName: string;
    shopSlug: string;
    saleMode: string;
    quantityMode: 'unique' | 'equivalent';
    quantityAvailable: number;
    unitPriceMinor: number;
    conditionLabel: string | null;
    sizeLabel: string | null;
  };
  quantity: number;
  reservation: { id: string; source: string; expiresAt: string; unitPriceMinor: number; quantity: number } | null;
  pendingOrderId: string | null;
  addresses: AddressView[];
  selectedAddress: AddressView | null;
  options: CheckoutOption[];
  holdMinutes: number;
  /** Why checkout can't proceed right now (shown instead of the pay button). */
  blocked: string | null;
  policies: { title: string; body: string }[];
  serverNow: string;
}

type Source = { listing?: string; offer?: string; auction?: string; secondChance?: string; address?: string; quantity?: string };

const uuidOk = (v?: string) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

/** Resolves a reservation the caller owns from an offer thread, auction or second-chance offer id. */
async function reservationFor(ctx: AppContext, userId: string, src: Source): Promise<string | null> {
  if (uuidOk(src.offer)) {
    const r = await maybeOne<{ reservation_id: string | null }>(ctx.pool, 'SELECT reservation_id FROM offer_threads WHERE id = $1 AND buyer_user_id = $2', [src.offer, userId]);
    if (!r) throw new DomainError('NOT_FOUND', 'Offer not found.');
    return r.reservation_id;
  }
  if (uuidOk(src.auction)) {
    const r = await maybeOne<{ reservation_id: string | null }>(ctx.pool, 'SELECT reservation_id FROM auctions WHERE id = $1 AND winner_user_id = $2', [src.auction, userId]);
    if (!r) throw new DomainError('NOT_FOUND', 'Auction win not found.');
    return r.reservation_id;
  }
  if (uuidOk(src.secondChance)) {
    const r = await maybeOne<{ reservation_id: string | null }>(ctx.pool, 'SELECT reservation_id FROM second_chance_offers WHERE id = $1 AND bidder_user_id = $2', [src.secondChance, userId]);
    if (!r) throw new DomainError('NOT_FOUND', 'Offer not found.');
    return r.reservation_id;
  }
  return null;
}

export async function getCheckoutContext(ctx: AppContext, src: Source): Promise<CheckoutContext> {
  const user = requireUser(ctx);
  const settings = await getSettings(ctx.pool);
  let mode: CheckoutContext['mode'] = 'listing';
  let listingId: string | null = uuidOk(src.listing) ? src.listing! : null;
  let reservation: CheckoutContext['reservation'] = null;
  let pendingOrderId: string | null = null;
  let blocked: string | null = null;
  if (!listingId) {
    mode = 'reservation';
    const reservationId = await reservationFor(ctx, user.userId, src);
    if (!reservationId) throw new DomainError('NOT_FOUND', 'There is nothing reserved for you to pay for here.');
    const r = await one<{ id: string; listing_id: string; source: string; expires_at: Date; unit_price_minor: number; quantity: number; status: string }>(
      ctx.pool,
      'SELECT id, listing_id, source, expires_at, unit_price_minor, quantity, status FROM reservations WHERE id = $1 AND buyer_user_id = $2',
      [reservationId, user.userId],
    );
    listingId = r.listing_id;
    reservation = { id: r.id, source: r.source, expiresAt: new Date(r.expires_at).toISOString(), unitPriceMinor: r.unit_price_minor, quantity: r.quantity };
    const pending = await maybeOne<{ id: string }>(ctx.pool, `SELECT id FROM orders WHERE reservation_id = $1 AND status = 'pending_payment'`, [r.id]);
    pendingOrderId = pending?.id ?? null;
    const paid = await maybeOne<{ id: string }>(ctx.pool, `SELECT id FROM orders WHERE reservation_id = $1 AND status IN ('confirmed','completed')`, [r.id]);
    if (paid) pendingOrderId = paid.id;
    if (!paid && (r.status !== 'active' || new Date(r.expires_at) <= ctx.now())) blocked = 'This hold has expired, so the item is no longer reserved for you.';
  }
  const l = await maybeOne<{
    id: string; title: string; status: string; sale_mode: string; quantity_mode: 'unique' | 'equivalent'; price_minor: number | null;
    condition: ConditionGrade | null; size_label: string | null; shop_name: string; shop_slug: string; shop_status: string; shop_id: string;
    quantity_available: number | null; photo_key: string | null; is_member: boolean; [k: string]: unknown;
  }>(
    ctx.pool,
    `SELECT l.id, l.title, l.status, l.sale_mode, l.quantity_mode, l.price_minor, l.condition, l.size_label, s.name AS shop_name, s.slug AS shop_slug,
            s.status AS shop_status, s.id AS shop_id, st.quantity_available,
            (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key,
            EXISTS (SELECT 1 FROM shop_members sm WHERE sm.shop_id = s.id AND sm.user_id = $2) AS is_member
       FROM listings l JOIN shops s ON s.id = l.shop_id LEFT JOIN inventory_stock st ON st.listing_id = l.id WHERE l.id = $1`,
    [listingId, user.userId],
  );
  if (!l) throw new DomainError('NOT_FOUND', 'This item is not available.');
  if (mode === 'listing') {
    // Coming back to an item you're already paying for resumes that checkout instead of conflicting with your own hold.
    const mine = await maybeOne<{ id: string }>(
      ctx.pool,
      `SELECT o.id FROM orders o JOIN reservations r ON r.id = o.reservation_id
        WHERE r.listing_id = $1 AND o.buyer_user_id = $2 AND o.status = 'pending_payment' AND r.status IN ('active','payment_pending')
        ORDER BY o.created_at DESC LIMIT 1`,
      [l.id, user.userId],
    );
    pendingOrderId = mine?.id ?? null;
    if (l.is_member) blocked = 'You can’t buy from your own shop.';
    else if (l.sale_mode === 'auction') blocked = 'Auction pieces are bought by bidding on the auction page.';
    else if (l.shop_status !== 'active') blocked = 'This shop isn’t taking new orders right now.';
    else if (l.status !== 'active' || (l.quantity_available ?? 0) < 1) blocked = l.status === 'sold' ? 'This piece has sold.' : 'This piece is reserved or unavailable right now.';
    else if (!l.price_minor) blocked = 'This piece has no price yet.';
  }
  const quantity = reservation?.quantity ?? (l.quantity_mode === 'equivalent' ? Math.min(Math.max(Number(src.quantity) || 1, 1), Math.max(l.quantity_available ?? 1, 1)) : 1);
  const unitPrice = reservation?.unitPriceMinor ?? l.price_minor ?? 0;
  const addresses = await listAddresses(ctx);
  const selectedAddress = addresses.find((a) => a.id === src.address) ?? addresses.find((a) => a.isDefault) ?? addresses[0] ?? null;
  const fees = { commissionBps: settings.commission_bps, buyerFeeBps: settings.buyer_fee_bps, buyerFeeFlatMinor: settings.buyer_fee_flat_minor };
  const options: CheckoutOption[] =
    selectedAddress && unitPrice > 0
      ? (await quoteDeliveryOptions(ctx.pool, { listingId: l.id, destination: { state: selectedAddress.state, city: selectedAddress.city } })).map((o) => {
          const t = computeOrderTotals({ unitPriceMinor: unitPrice, quantity, shippingMinor: o.feeMinor, fees, shippingPaidToSeller: o.method !== 'integrated' });
          return { ...o, totals: { itemsTotalMinor: t.itemsTotalMinor, shippingMinor: t.shippingMinor, buyerFeeMinor: t.buyerFeeMinor, totalMinor: t.totalMinor } };
        })
      : [];
  const policies = await many<{ title: string; body: string }>(
    ctx.pool,
    `SELECT DISTINCT ON (kind) title, body FROM policy_versions WHERE kind IN ('checkout_terms','buyer_protection') AND effective_at <= now() ORDER BY kind, effective_at DESC`,
  );
  return {
    mode,
    listing: {
      id: l.id,
      title: l.title,
      photoUrl: l.photo_key ? mediaPath(l.photo_key, 'thumb') : null,
      shopName: l.shop_name,
      shopSlug: l.shop_slug,
      saleMode: l.sale_mode,
      quantityMode: l.quantity_mode,
      quantityAvailable: l.quantity_available ?? 0,
      unitPriceMinor: unitPrice,
      conditionLabel: l.condition ? CONDITION_INFO[l.condition].label : null,
      sizeLabel: l.size_label,
    },
    quantity,
    reservation,
    pendingOrderId,
    addresses,
    selectedAddress,
    options,
    holdMinutes: settings.checkout_hold_minutes,
    blocked,
    policies,
    serverNow: ctx.now().toISOString(),
  };
}
