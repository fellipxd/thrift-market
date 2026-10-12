import { applyStockMovement, DomainError, type StockLevels } from '@thrift/domain';
import { maybeOne, one, type Queryable } from '@thrift/database';

/**
 * THE inventory authority. Every allocation path — fixed-price checkout, accepted offer, auction win,
 * second-chance offer — reserves stock through reserveStock() inside a short transaction.
 *
 * Lock order (always acquire in this order to avoid deadlocks):
 *   auctions → offer_threads → inventory_stock → reservations → orders → payment_attempts → payouts
 * Several stock rows in one transaction (a same-seller bag order) are taken in listing-id order (ADR-0009).
 *
 * Callers pass a transaction client (Tx). Never call external providers while these locks are held.
 *
 * restoreSoldUnits() is the only path that moves units out of "sold": used when a paid order is cancelled before
 * dispatch (the unit never left the seller), recorded as an 'adjust' movement.
 */

export interface StockRow extends StockLevels {
  listingId: string;
  version: number;
}

interface StockDbRow {
  listing_id: string;
  quantity_total: number;
  quantity_available: number;
  quantity_reserved: number;
  quantity_sold: number;
  quantity_withdrawn: number;
  version: number;
  [k: string]: unknown;
}

function toStock(r: StockDbRow): StockRow {
  return {
    listingId: r.listing_id,
    quantityTotal: r.quantity_total,
    quantityAvailable: r.quantity_available,
    quantityReserved: r.quantity_reserved,
    quantitySold: r.quantity_sold,
    quantityWithdrawn: r.quantity_withdrawn,
    version: r.version,
  };
}

export async function lockStock(tx: Queryable, listingId: string): Promise<StockRow> {
  const row = await maybeOne<StockDbRow>(tx, 'SELECT * FROM inventory_stock WHERE listing_id = $1 FOR UPDATE', [listingId]);
  if (!row) throw new DomainError('NOT_FOUND', 'This item is not available.');
  return toStock(row);
}

export async function readStock(db: Queryable, listingId: string): Promise<StockRow | null> {
  const row = await maybeOne<StockDbRow>(db, 'SELECT * FROM inventory_stock WHERE listing_id = $1', [listingId]);
  return row ? toStock(row) : null;
}

async function writeStock(tx: Queryable, s: StockRow): Promise<void> {
  await tx.query(
    `UPDATE inventory_stock
        SET quantity_total = $2, quantity_available = $3, quantity_reserved = $4, quantity_sold = $5,
            quantity_withdrawn = $6, version = version + 1, updated_at = now()
      WHERE listing_id = $1`,
    [s.listingId, s.quantityTotal, s.quantityAvailable, s.quantityReserved, s.quantitySold, s.quantityWithdrawn],
  );
}

/** Keeps listings.status consistent with stock for listings that are on sale. */
async function syncListingStatus(tx: Queryable, s: StockRow): Promise<void> {
  await tx.query(
    `UPDATE listings SET
        status = CASE
          WHEN status NOT IN ('active','reserved','sold') THEN status
          WHEN $2 > 0 THEN 'active'
          WHEN $3 > 0 THEN 'reserved'
          WHEN $4 > 0 THEN 'sold'
          ELSE status END,
        sold_at = CASE WHEN $2 = 0 AND $3 = 0 AND $4 > 0 AND sold_at IS NULL THEN now() ELSE sold_at END,
        updated_at = now()
      WHERE id = $1`,
    [s.listingId, s.quantityAvailable, s.quantityReserved, s.quantitySold],
  );
}

export interface ReserveInput {
  listingId: string;
  buyerUserId: string;
  quantity: number;
  source: 'checkout' | 'offer' | 'auction' | 'second_chance';
  sourceId: string | null;
  unitPriceMinor: number;
  expiresAt: Date;
  actorUserId?: string | null;
}

export interface Reservation {
  id: string;
  listing_id: string;
  buyer_user_id: string;
  quantity: number;
  source: ReserveInput['source'];
  source_id: string | null;
  unit_price_minor: number;
  status: 'active' | 'payment_pending' | 'converted' | 'released' | 'expired';
  expires_at: Date;
  grace_until: Date | null;
  created_at: Date;
  [k: string]: unknown;
}

/**
 * Atomically moves `quantity` from available to reserved and records the reservation.
 * First valid reservation committed by the server wins; losers get STOCK_CONFLICT.
 */
export async function reserveStock(tx: Queryable, input: ReserveInput): Promise<Reservation> {
  const stock = await lockStock(tx, input.listingId);
  const next = { ...stock, ...applyStockMovement(stock, { kind: 'reserve', quantity: input.quantity }) };
  await writeStock(tx, next);
  const reservation = await one<Reservation>(
    tx,
    `INSERT INTO reservations (listing_id, buyer_user_id, quantity, source, source_id, unit_price_minor, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.listingId, input.buyerUserId, input.quantity, input.source, input.sourceId, input.unitPriceMinor, input.expiresAt],
  );
  await tx.query(
    `INSERT INTO inventory_movements (listing_id, kind, quantity, reservation_id, actor_user_id, reason)
     VALUES ($1, 'reserve', $2, $3, $4, $5)`,
    [input.listingId, input.quantity, reservation.id, input.actorUserId ?? input.buyerUserId, input.source],
  );
  await syncListingStatus(tx, next);
  return reservation;
}

export async function lockReservation(tx: Queryable, reservationId: string): Promise<Reservation> {
  const r = await maybeOne<Reservation>(tx, 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
  if (!r) throw new DomainError('NOT_FOUND', 'Reservation not found.');
  return r;
}

/**
 * Returns reserved stock to available. Idempotent: releasing an already closed reservation is a no-op.
 * Callers must have established that no payment can still succeed for this reservation
 * (e.g. provider verification says failed/abandoned/not found) — a local timer alone is not enough.
 */
export async function releaseReservation(
  tx: Queryable,
  reservationId: string,
  args: { reason: string; status?: 'released' | 'expired'; actorUserId?: string | null },
): Promise<{ released: boolean }> {
  // Lock order: inventory_stock before reservations.
  const peek = await maybeOne<{ listing_id: string }>(tx, 'SELECT listing_id FROM reservations WHERE id = $1', [reservationId]);
  if (!peek) throw new DomainError('NOT_FOUND', 'Reservation not found.');
  const stock = await lockStock(tx, peek.listing_id);
  const r = await lockReservation(tx, reservationId);
  if (r.status !== 'active' && r.status !== 'payment_pending') return { released: false };
  const next = { ...stock, ...applyStockMovement(stock, { kind: 'release', quantity: r.quantity }) };
  await writeStock(tx, next);
  await tx.query(
    `UPDATE reservations SET status = $2, release_reason = $3, closed_at = now(), updated_at = now() WHERE id = $1`,
    [r.id, args.status ?? 'released', args.reason],
  );
  await tx.query(
    `INSERT INTO inventory_movements (listing_id, kind, quantity, reservation_id, actor_user_id, reason)
     VALUES ($1, 'release', $2, $3, $4, $5)`,
    [r.listing_id, r.quantity, r.id, args.actorUserId ?? null, args.reason],
  );
  await syncListingStatus(tx, next);
  return { released: true };
}

/** Marks a hold as awaiting payment reconciliation (expired while a provider outcome is unknown). */
export async function markReservationPaymentPending(tx: Queryable, reservationId: string, graceUntil: Date): Promise<void> {
  await tx.query(
    `UPDATE reservations SET status = 'payment_pending', grace_until = $2, updated_at = now()
      WHERE id = $1 AND status = 'active'`,
    [reservationId, graceUntil],
  );
}

/**
 * Converts a reservation into a sale (reserved → sold) when its payment is verified.
 * If the reservation was already released (late payment), tries to re-allocate the same quantity from
 * available stock; if none is available returns { converted: false } and the caller must refund.
 * Never assigns a unit to a second paid order.
 */
export async function convertReservation(
  tx: Queryable,
  reservationId: string,
): Promise<{ converted: boolean; reallocated: boolean }> {
  const peek = await maybeOne<{ listing_id: string }>(tx, 'SELECT listing_id FROM reservations WHERE id = $1', [reservationId]);
  if (!peek) throw new DomainError('NOT_FOUND', 'Reservation not found.');
  const stock = await lockStock(tx, peek.listing_id);
  const r = await lockReservation(tx, reservationId);
  if (r.status === 'converted') return { converted: true, reallocated: false };
  let levels = stock;
  let reallocated = false;
  if (r.status === 'released' || r.status === 'expired') {
    if (stock.quantityAvailable < r.quantity) return { converted: false, reallocated: false };
    levels = { ...stock, ...applyStockMovement(stock, { kind: 'reserve', quantity: r.quantity }) };
    reallocated = true;
  }
  const next = { ...levels, ...applyStockMovement(levels, { kind: 'sell', quantity: r.quantity }) };
  await writeStock(tx, next);
  await tx.query(`UPDATE reservations SET status = 'converted', closed_at = now(), updated_at = now() WHERE id = $1`, [r.id]);
  await tx.query(
    `INSERT INTO inventory_movements (listing_id, kind, quantity, reservation_id, reason) VALUES ($1, 'sell', $2, $3, $4)`,
    [r.listing_id, r.quantity, r.id, reallocated ? 'late_payment_reallocated' : 'payment_verified'],
  );
  await syncListingStatus(tx, next);
  return { converted: true, reallocated };
}

/** Seller marks units sold elsewhere / withdraws them. Only available units can be withdrawn. */
export async function withdrawStock(
  tx: Queryable,
  args: { listingId: string; quantity: number; reason: string; actorUserId: string },
): Promise<StockRow> {
  const stock = await lockStock(tx, args.listingId);
  const next = { ...stock, ...applyStockMovement(stock, { kind: 'withdraw', quantity: args.quantity }) };
  await writeStock(tx, next);
  await tx.query(
    `INSERT INTO inventory_movements (listing_id, kind, quantity, actor_user_id, reason) VALUES ($1, 'withdraw', $2, $3, $4)`,
    [args.listingId, args.quantity, args.actorUserId, args.reason],
  );
  if (next.quantityAvailable === 0 && next.quantityReserved === 0) {
    await tx.query(
      `UPDATE listings SET status = CASE WHEN status IN ('active','reserved') THEN 'ended' ELSE status END, updated_at = now() WHERE id = $1`,
      [args.listingId],
    );
  }
  return { ...next, version: stock.version + 1 };
}

/** Adds equivalent units (only for quantity_mode = 'equivalent' listings; caller checks). */
export async function restock(tx: Queryable, args: { listingId: string; quantity: number; actorUserId: string }): Promise<StockRow> {
  const stock = await lockStock(tx, args.listingId);
  const next = { ...stock, ...applyStockMovement(stock, { kind: 'restock', quantity: args.quantity }) };
  await writeStock(tx, next);
  await tx.query(
    `INSERT INTO inventory_movements (listing_id, kind, quantity, actor_user_id, reason) VALUES ($1, 'restock', $2, $3, 'restock')`,
    [args.listingId, args.quantity, args.actorUserId],
  );
  await syncListingStatus(tx, next);
  return { ...next, version: stock.version + 1 };
}

/** Creates the stock row for a new listing. */
export async function initialiseStock(tx: Queryable, listingId: string, quantity: number): Promise<void> {
  await tx.query(
    `INSERT INTO inventory_stock (listing_id, quantity_total, quantity_available) VALUES ($1, $2, $2)
     ON CONFLICT (listing_id) DO NOTHING`,
    [listingId, quantity],
  );
  await tx.query(`INSERT INTO inventory_movements (listing_id, kind, quantity, reason) VALUES ($1, 'stock_in', $2, 'listing_created')`, [
    listingId,
    quantity,
  ]);
}

/** Counts a buyer's open holds (abuse control on reservation hoarding). */
export async function countActiveReservations(db: Queryable, buyerUserId: string): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM reservations WHERE buyer_user_id = $1 AND status IN ('active','payment_pending')`,
    [buyerUserId],
  );
  return row.n;
}

/**
 * Moves units from sold back to available when a paid order is cancelled before dispatch (the piece never left
 * the seller). Recorded as an 'adjust' movement with the reason; listing status follows stock.
 */
export async function restoreSoldUnits(tx: Queryable, args: { listingId: string; quantity: number; reason: string; actorUserId?: string | null }): Promise<StockRow> {
  const stock = await lockStock(tx, args.listingId);
  if (!Number.isInteger(args.quantity) || args.quantity <= 0) throw new DomainError('VALIDATION_FAILED', 'Quantity must be a positive integer');
  if (stock.quantitySold < args.quantity) throw new DomainError('INVALID_STATE', 'Only sold units can be restored');
  const next: StockRow = { ...stock, quantitySold: stock.quantitySold - args.quantity, quantityAvailable: stock.quantityAvailable + args.quantity };
  await writeStock(tx, next);
  await tx.query(
    `INSERT INTO inventory_movements (listing_id, kind, quantity, actor_user_id, reason) VALUES ($1, 'adjust', $2, $3, $4)`,
    [args.listingId, args.quantity, args.actorUserId ?? null, args.reason],
  );
  await tx.query(
    `UPDATE listings SET status = CASE WHEN status IN ('sold','reserved','active') THEN (CASE WHEN $2 > 0 THEN 'active' WHEN $3 > 0 THEN 'reserved' ELSE status END) ELSE status END,
            sold_at = CASE WHEN $2 > 0 THEN NULL ELSE sold_at END, updated_at = now() WHERE id = $1`,
    [args.listingId, next.quantityAvailable, next.quantityReserved],
  );
  return { ...next, version: stock.version + 1 };
}
