import { reservationCheckoutInput, startCheckoutInput } from '@thrift/contracts';
import {
  computeOrderTotals,
  DomainError,
  pickDeliveryOption,
  type DeliveryMethod,
  type DeliveryOption,
  type FeeSettings,
} from '@thrift/domain';
import { many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { assertShopCanSell, requireUser, requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { withIdempotency } from '../core/idempotency';
import { enforceRateLimit } from '../core/rate-limit';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { getOwnAddress, type AddressView } from '../addresses/addresses';
import { quoteDeliveryOptions } from '../delivery/quote';
import { countActiveReservations, lockReservation, releaseReservation, reserveStock, type Reservation } from '../inventory/authority';
import { buildOrderItemSnapshot, currentPolicyVersions } from '../orders/snapshot';
import { createPaymentAttempt, initializePaymentAttempt } from '../payments/attempts';
import { applyVerifiedPayment } from '../payments/apply';
import { enqueueReservationReleased } from './expiry';

export interface CheckoutStarted {
  orderId: string;
  orderNumber: string;
  authorizationUrl: string | null;
  paymentStatus: 'pending' | 'uncertain';
  reservationExpiresAt: string;
  totals: { itemsTotalMinor: number; shippingMinor: number; buyerFeeMinor: number; totalMinor: number };
}

function feeSettings(s: Awaited<ReturnType<typeof getSettings>>): FeeSettings {
  return { commissionBps: s.commission_bps, buyerFeeBps: s.buyer_fee_bps, buyerFeeFlatMinor: s.buyer_fee_flat_minor };
}

interface SellableListing {
  id: string;
  shop_id: string;
  status: string;
  sale_mode: string;
  quantity_mode: 'unique' | 'equivalent';
  price_minor: number | null;
  shop_status: string;
  owner_user_id: string;
  [k: string]: unknown;
}

async function loadSellable(db: Queryable, listingId: string): Promise<SellableListing> {
  const l = await maybeOne<SellableListing>(
    db,
    `SELECT l.id, l.shop_id, l.status, l.sale_mode, l.quantity_mode, l.price_minor, s.status AS shop_status, s.owner_user_id
       FROM listings l JOIN shops s ON s.id = l.shop_id WHERE l.id = $1`,
    [listingId],
  );
  if (!l) throw new DomainError('NOT_FOUND', 'This item is not available.');
  return l;
}

async function assertNotOwnShop(db: Queryable, shopId: string, userId: string): Promise<void> {
  const member = await maybeOne(db, 'SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2', [shopId, userId]);
  if (member) throw new DomainError('FORBIDDEN', 'You can’t buy from your own shop.');
}

function addressSnapshot(a: AddressView): Record<string, unknown> {
  return { recipientName: a.recipientName, phone: a.phone, line1: a.line1, line2: a.line2, area: a.area, city: a.city, state: a.state, landmark: a.landmark };
}

/**
 * Creates the order, its immutable item snapshot and a payment attempt for an existing reservation (same
 * transaction as the reservation for fresh checkouts; a new short transaction for offer/auction reservations).
 */
async function createOrderForReservation(
  tx: Queryable,
  ctx: AppContext,
  args: {
    reservation: Reservation;
    shopId: string;
    buyerUserId: string;
    source: 'checkout' | 'offer' | 'auction' | 'second_chance';
    sourceId: string | null;
    address: AddressView;
    option: DeliveryOption;
    fees: FeeSettings;
    idempotencyKey: string;
  },
): Promise<{ orderId: string; orderNumber: string; attemptId: string; totals: CheckoutStarted['totals'] }> {
  const totals = computeOrderTotals({
    unitPriceMinor: args.reservation.unit_price_minor,
    quantity: args.reservation.quantity,
    shippingMinor: args.option.feeMinor,
    fees: args.fees,
    shippingPaidToSeller: args.option.method !== 'integrated',
  });
  const order = await one<{ id: string; number: string }>(
    tx,
    `INSERT INTO orders (buyer_user_id, shop_id, source, source_id, reservation_id, items_total_minor, shipping_minor, buyer_fee_minor, total_minor,
                         commission_minor, delivery_method, shipping_address, delivery_terms, policy_versions, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id, number`,
    [
      args.buyerUserId,
      args.shopId,
      args.source,
      args.sourceId,
      args.reservation.id,
      totals.itemsTotalMinor,
      totals.shippingMinor,
      totals.buyerFeeMinor,
      totals.totalMinor,
      totals.commissionMinor,
      args.option.method,
      JSON.stringify(addressSnapshot(args.address)),
      JSON.stringify({
        method: args.option.method,
        label: args.option.label,
        feeMinor: args.option.feeMinor,
        dispatchDays: args.option.dispatchDays,
        transitDaysMin: args.option.transitDaysMin,
        transitDaysMax: args.option.transitDaysMax,
        trackingNote: args.option.trackingNote,
        protectionEligible: args.option.protectionEligible,
      }),
      JSON.stringify(await currentPolicyVersions(tx)),
      args.idempotencyKey,
    ],
  );
  const snap = await buildOrderItemSnapshot(tx, { listingId: args.reservation.listing_id, unitPriceMinor: args.reservation.unit_price_minor, quantity: args.reservation.quantity });
  await tx.query(
    `INSERT INTO order_items (order_id, listing_id, listing_version_id, quantity, unit_price_minor, snapshot) VALUES ($1, $2, $3, $4, $5, $6)`,
    [order.id, args.reservation.listing_id, snap.listingVersionId, args.reservation.quantity, args.reservation.unit_price_minor, JSON.stringify(snap.snapshot)],
  );
  await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, actor_user_id, data) VALUES ($1, 'order_created', 'buyer', $2, $3)`, [
    order.id,
    args.buyerUserId,
    JSON.stringify({ source: args.source, reservationId: args.reservation.id, expiresAt: args.reservation.expires_at }),
  ]);
  const attempt = await createPaymentAttempt(tx, ctx, { orderId: order.id, payerUserId: args.buyerUserId, amountMinor: totals.totalMinor });
  return { orderId: order.id, orderNumber: order.number, attemptId: attempt.id, totals };
}

async function deliveryOptionFor(db: Queryable, listingId: string, address: AddressView, method: DeliveryMethod): Promise<DeliveryOption> {
  const options = await quoteDeliveryOptions(db, { listingId, destination: { state: address.state, city: address.city } });
  if (options.length === 0) {
    throw new DomainError('NOT_DELIVERABLE', `This item can’t be delivered to ${address.city}, ${address.state}. Choose another address.`, {
      fieldErrors: { addressId: 'Not deliverable to this address.' },
    });
  }
  return pickDeliveryOption(options, method);
}

/**
 * Fixed-price checkout (fixed or negotiable listing at the listed price). One short transaction reserves the
 * unit through the inventory authority and records the order + payment attempt; the provider is called after
 * commit. First valid reservation committed wins; others get STOCK_CONFLICT and no order.
 */
export async function startCheckout(ctx: AppContext, raw: unknown): Promise<CheckoutStarted> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(startCheckoutInput, raw);
  await enforceRateLimit(ctx.pool, `checkout:${user.userId}`, 30, 3600, 'Too many checkout attempts. Wait a few minutes and try again.');
  return withIdempotency(ctx.pool, { scope: 'checkout.start', actorId: user.userId, key: input.idempotencyKey, request: input }, async () => {
    const settings = await getSettings(ctx.pool);
    const pre = await loadSellable(ctx.pool, input.listingId);
    await assertNotOwnShop(ctx.pool, pre.shop_id, user.userId);
    if (pre.sale_mode === 'auction') throw new DomainError('INVALID_STATE', 'Auction pieces are bought by bidding. Open the auction page.');
    if (pre.quantity_mode === 'unique' && input.quantity !== 1) throw new DomainError('VALIDATION_FAILED', 'This is a unique piece.');
    if ((await countActiveReservations(ctx.pool, user.userId)) >= settings.max_active_reservations_per_buyer) {
      throw new DomainError('RATE_LIMITED', 'You have several checkouts in progress. Finish or cancel one before starting another.');
    }
    const address = await getOwnAddress(ctx.pool, user.userId, input.addressId);
    const option = await deliveryOptionFor(ctx.pool, input.listingId, address, input.deliveryMethod);
    const expiresAt = new Date(ctx.now().getTime() + settings.checkout_hold_minutes * 60_000);
    const created = await withTransaction(ctx.pool, async (tx) => {
      const l = await loadSellable(tx, input.listingId);
      if (l.status !== 'active' && l.status !== 'reserved') throw new DomainError('STOCK_CONFLICT', l.status === 'sold' ? 'This piece has sold.' : 'This item is not available right now.');
      if (l.sale_mode !== 'fixed' && l.sale_mode !== 'negotiable') throw new DomainError('INVALID_STATE', 'This item can’t be bought at a fixed price.');
      assertShopCanSell({ status: l.shop_status });
      if (!l.price_minor) throw new DomainError('INVALID_STATE', 'This item has no price yet.');
      const reservation = await reserveStock(tx, {
        listingId: l.id,
        buyerUserId: user.userId,
        quantity: input.quantity,
        source: 'checkout',
        sourceId: null,
        unitPriceMinor: l.price_minor,
        expiresAt,
      });
      const res = await createOrderForReservation(tx, ctx, {
        reservation,
        shopId: l.shop_id,
        buyerUserId: user.userId,
        source: 'checkout',
        sourceId: null,
        address,
        option,
        fees: feeSettings(settings),
        idempotencyKey: input.idempotencyKey,
      });
      return { ...res, expiresAt };
    });
    const init = await initializePaymentAttempt(ctx, created.attemptId, { callbackPath: '/checkout/return', description: `Order ${created.orderNumber}` });
    return {
      orderId: created.orderId,
      orderNumber: created.orderNumber,
      authorizationUrl: init.authorizationUrl,
      paymentStatus: init.status,
      reservationExpiresAt: created.expiresAt.toISOString(),
      totals: created.totals,
    };
  });
}

/**
 * Checkout for a reservation created by another flow (accepted offer, auction win, second-chance offer). The
 * agreed unit price comes from the reservation — sellers cannot change it. Resumes an existing unpaid order.
 */
export async function startCheckoutForReservation(ctx: AppContext, raw: unknown): Promise<CheckoutStarted> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(reservationCheckoutInput, raw);
  await enforceRateLimit(ctx.pool, `checkout:${user.userId}`, 30, 3600);
  return withIdempotency(ctx.pool, { scope: 'checkout.reservation', actorId: user.userId, key: input.idempotencyKey, request: input }, async () => {
    const settings = await getSettings(ctx.pool);
    const resv = await maybeOne<Reservation>(ctx.pool, 'SELECT * FROM reservations WHERE id = $1 AND buyer_user_id = $2', [input.reservationId, user.userId]);
    if (!resv) throw new DomainError('NOT_FOUND', 'This reservation could not be found.');
    const existing = await maybeOne<{ id: string }>(ctx.pool, `SELECT id FROM orders WHERE reservation_id = $1 AND status = 'pending_payment'`, [resv.id]);
    if (existing) return resumePendingOrder(ctx, existing.id);
    if (resv.status !== 'active' || new Date(resv.expires_at) <= ctx.now()) throw new DomainError('EXPIRED', 'This hold has expired, so the item is no longer reserved for you.');
    const l = await loadSellable(ctx.pool, resv.listing_id);
    const address = await getOwnAddress(ctx.pool, user.userId, input.addressId);
    const option = await deliveryOptionFor(ctx.pool, resv.listing_id, address, input.deliveryMethod);
    const created = await withTransaction(ctx.pool, async (tx) => {
      const r = await lockReservation(tx, resv.id);
      if (r.status !== 'active' || new Date(r.expires_at) <= ctx.now()) throw new DomainError('EXPIRED', 'This hold has expired.');
      return createOrderForReservation(tx, ctx, {
        reservation: r,
        shopId: l.shop_id,
        buyerUserId: user.userId,
        source: r.source,
        sourceId: r.source_id,
        address,
        option,
        fees: feeSettings(settings),
        idempotencyKey: input.idempotencyKey,
      });
    });
    const init = await initializePaymentAttempt(ctx, created.attemptId, { callbackPath: '/checkout/return', description: `Order ${created.orderNumber}` });
    return {
      orderId: created.orderId,
      orderNumber: created.orderNumber,
      authorizationUrl: init.authorizationUrl,
      paymentStatus: init.status,
      reservationExpiresAt: new Date(resv.expires_at).toISOString(),
      totals: created.totals,
    };
  });
}

/** Resolves any unresolved attempt first (never allows two concurrent unresolved attempts), then pays again. */
async function resumePendingOrder(ctx: AppContext, orderId: string): Promise<CheckoutStarted> {
  return retryPayment(ctx, { orderId });
}

export async function retryPayment(ctx: AppContext, raw: unknown): Promise<CheckoutStarted> {
  const user = requireVerifiedUser(ctx);
  const orderId = String((raw as { orderId?: unknown })?.orderId ?? '');
  const o = await maybeOne<{ id: string; number: string; status: string; reservation_id: string; total_minor: number; items_total_minor: number; shipping_minor: number; buyer_fee_minor: number }>(
    ctx.pool,
    `SELECT id, number, status, reservation_id, total_minor, items_total_minor, shipping_minor, buyer_fee_minor FROM orders WHERE id = $1 AND buyer_user_id = $2`,
    [/^[0-9a-f-]{36}$/i.test(orderId) ? orderId : '00000000-0000-0000-0000-000000000000', user.userId],
  );
  if (!o) throw new DomainError('NOT_FOUND', 'Order not found.');
  if (o.status !== 'pending_payment') throw new DomainError('INVALID_STATE', o.status === 'cancelled' ? 'This order was cancelled.' : 'This order is already paid.');
  const unresolved = await many<{ reference: string; authorization_url: string | null; status: string }>(
    ctx.pool,
    `SELECT reference, authorization_url, status FROM payment_attempts WHERE order_id = $1 AND status IN ('initiated','pending','uncertain') ORDER BY created_at DESC`,
    [o.id],
  );
  for (const a of unresolved) {
    const r = await applyVerifiedPayment(ctx, a.reference);
    if (r.outcome === 'paid' || r.outcome === 'already_applied' || r.outcome === 'late_reallocated') {
      throw new DomainError('CONFLICT', 'Good news — this order is already paid.', { orderId: o.id });
    }
  }
  const stillPending = await maybeOne<{ authorization_url: string | null; status: string }>(
    ctx.pool,
    `SELECT authorization_url, status FROM payment_attempts WHERE order_id = $1 AND status IN ('initiated','pending','uncertain') ORDER BY created_at DESC LIMIT 1`,
    [o.id],
  );
  const resv = await one<{ expires_at: Date; status: string }>(ctx.pool, 'SELECT expires_at, status FROM reservations WHERE id = $1', [o.reservation_id]);
  const totals = { itemsTotalMinor: o.items_total_minor, shippingMinor: o.shipping_minor, buyerFeeMinor: o.buyer_fee_minor, totalMinor: o.total_minor };
  if (stillPending) {
    // An attempt is still open at the provider: send the buyer back to it instead of opening a second one.
    return {
      orderId: o.id,
      orderNumber: o.number,
      authorizationUrl: stillPending.authorization_url,
      paymentStatus: stillPending.status === 'pending' ? 'pending' : 'uncertain',
      reservationExpiresAt: new Date(resv.expires_at).toISOString(),
      totals,
    };
  }
  if (resv.status !== 'active' || new Date(resv.expires_at) <= ctx.now()) throw new DomainError('EXPIRED', 'The hold on this item has expired. Start a new checkout if it is still available.');
  const attempt = await withTransaction(ctx.pool, async (tx) => {
    await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [o.id]);
    const open = await maybeOne(tx, `SELECT 1 AS ok FROM payment_attempts WHERE order_id = $1 AND status IN ('initiated','pending','uncertain')`, [o.id]);
    if (open) throw new DomainError('CONFLICT', 'A payment for this order is already in progress. Check the order status.');
    return createPaymentAttempt(tx, ctx, { orderId: o.id, payerUserId: user.userId, amountMinor: o.total_minor });
  });
  const init = await initializePaymentAttempt(ctx, attempt.id, { callbackPath: '/checkout/return', description: `Order ${o.number}` });
  return { orderId: o.id, orderNumber: o.number, authorizationUrl: init.authorizationUrl, paymentStatus: init.status, reservationExpiresAt: new Date(resv.expires_at).toISOString(), totals };
}

/**
 * Buyer cancels an unpaid order. Unresolved payments are verified first: if one succeeded, it is applied
 * instead (the buyer has paid). Otherwise the hold is released and the order cancelled.
 */
export async function cancelPendingOrder(ctx: AppContext, raw: unknown): Promise<{ status: 'cancelled' | 'paid' }> {
  const user = requireUser(ctx);
  const orderId = String((raw as { orderId?: unknown })?.orderId ?? '');
  const o = await maybeOne<{ id: string; status: string; reservation_id: string }>(
    ctx.pool,
    `SELECT id, status, reservation_id FROM orders WHERE id = $1 AND buyer_user_id = $2`,
    [/^[0-9a-f-]{36}$/i.test(orderId) ? orderId : '00000000-0000-0000-0000-000000000000', user.userId],
  );
  if (!o) throw new DomainError('NOT_FOUND', 'Order not found.');
  if (o.status !== 'pending_payment') throw new DomainError('INVALID_STATE', 'Only unpaid orders can be cancelled here.');
  const unresolved = await many<{ reference: string }>(
    ctx.pool,
    `SELECT reference FROM payment_attempts WHERE order_id = $1 AND status IN ('initiated','pending','uncertain')`,
    [o.id],
  );
  for (const a of unresolved) {
    const r = await applyVerifiedPayment(ctx, a.reference);
    if (r.outcome === 'paid' || r.outcome === 'late_reallocated' || r.outcome === 'already_applied') return { status: 'paid' };
  }
  await withTransaction(ctx.pool, async (tx) => {
    // Fresh checkout holds are released. Offer/auction holds stay until their own deadline (the buyer may still pay).
    const resv = await one<{ source: string }>(tx, 'SELECT source FROM reservations WHERE id = $1', [o.reservation_id]);
    if (resv.source === 'checkout') {
      const rel = await releaseReservation(tx, o.reservation_id, { reason: 'buyer_cancelled', actorUserId: user.userId });
      if (rel.released) await enqueueReservationReleased(tx, o.reservation_id);
    }
    const res = await tx.query(
      `UPDATE orders SET status = 'cancelled', payment_status = 'failed', fulfilment_status = 'cancelled', cancel_reason = 'buyer_cancelled_unpaid',
              cancelled_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending_payment'`,
      [o.id],
    );
    if (res.rowCount) {
      // Attempts the provider says are pending stay as they are; a late success is refunded or re-allocated.
      await tx.query(`UPDATE payment_attempts SET status = 'abandoned', updated_at = now() WHERE order_id = $1 AND status = 'initiated'`, [o.id]);
      await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, actor_user_id) VALUES ($1, 'buyer_cancelled_unpaid', 'buyer', $2)`, [o.id, user.userId]);
    }
  });
  return { status: 'cancelled' };
}
