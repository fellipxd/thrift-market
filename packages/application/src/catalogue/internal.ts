import { DomainError, type AttributeSchema, type ConditionGrade, type PublishCandidate, type SaleMode, type SizeSystem } from '@thrift/domain';
import { many, maybeOne, type Queryable } from '@thrift/database';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { lockStock, type StockRow } from '../inventory/authority';
import { readAttributeSchema } from './schema';

/** Full listing row for owner-only code paths (includes the private min_offer_minor). */
export interface ListingRow {
  id: string;
  shop_id: string;
  category_id: string;
  schema_version_id: string;
  batch_id: string | null;
  status: 'draft' | 'scheduled' | 'active' | 'reserved' | 'sold' | 'paused' | 'ended' | 'removed';
  sale_mode: SaleMode;
  title: string;
  description: string;
  brand: string | null;
  colour: string | null;
  material: string | null;
  size_system: SizeSystem | null;
  size_label: string | null;
  measurements: Record<string, number>;
  attributes: Record<string, string>;
  condition: ConditionGrade | null;
  flaws_declaration: 'none_known' | 'described' | null;
  flaws_affirmed_at: Date | null;
  quantity_mode: 'unique' | 'equivalent';
  initial_quantity: number;
  price_minor: number | null;
  min_offer_minor: number | null;
  delivery_states: string[] | null;
  weight_grams: number | null;
  version: number;
  published_at: Date | null;
  sold_at: Date | null;
  created_at: Date;
  updated_at: Date;
  shop_status: 'draft' | 'active' | 'paused' | 'suspended';
  shop_state: string;
  shop_city: string;
  [k: string]: unknown;
}

const OWN_LISTING_SQL = `
  SELECT l.id, l.shop_id, l.category_id, l.schema_version_id, l.batch_id, l.status, l.sale_mode, l.title, l.description, l.brand, l.colour,
         l.material, l.size_system, l.size_label, l.measurements, l.attributes, l.condition, l.flaws_declaration, l.flaws_affirmed_at,
         l.quantity_mode, l.initial_quantity, l.price_minor, l.min_offer_minor, l.delivery_states, l.weight_grams, l.version,
         l.published_at, l.sold_at, l.created_at, l.updated_at,
         s.status AS shop_status, s.state AS shop_state, s.city AS shop_city
    FROM listings l
    JOIN shops s ON s.id = l.shop_id
    JOIN shop_members m ON m.shop_id = l.shop_id AND m.user_id = $2
   WHERE l.id = $1`;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Loads a listing only if the caller is a member of its shop. Anyone else gets NOT_FOUND (never FORBIDDEN),
 * so listing ids cannot be probed.
 */
export async function loadOwnListing(db: Queryable, ctx: AppContext, listingId: string, opts: { lock?: boolean } = {}): Promise<ListingRow> {
  const user = requireUser(ctx);
  if (!isUuid(listingId)) throw new DomainError('NOT_FOUND', 'Listing not found.');
  const row = await maybeOne<ListingRow>(db, `${OWN_LISTING_SQL}${opts.lock ? ' FOR UPDATE OF l' : ''}`, [listingId, user.userId]);
  if (!row) throw new DomainError('NOT_FOUND', 'Listing not found.');
  return row;
}

export interface EditLock {
  listing: ListingRow;
  stock: StockRow | null;
  auction: { id: string; status: string; bid_count: number } | null;
  hasActiveReservation: boolean;
  auctionHasBids: boolean;
}

/**
 * Takes the locks needed to change a listing, in the documented order
 * (auctions → inventory_stock → listing row), then reads reservation state under those locks so that a
 * concurrent checkout / offer acceptance / auction allocation cannot slip between the check and the edit.
 */
export async function lockForEdit(tx: Queryable, ctx: AppContext, listingId: string): Promise<EditLock> {
  const peek = await loadOwnListing(tx, ctx, listingId);
  let auction: EditLock['auction'] = null;
  let stock: StockRow | null = null;
  if (peek.status !== 'draft') {
    auction = await maybeOne<{ id: string; status: string; bid_count: number }>(
      tx,
      `SELECT id, status, bid_count FROM auctions WHERE listing_id = $1 FOR UPDATE`,
      [listingId],
    );
    const hasStock = await maybeOne(tx, `SELECT 1 AS ok FROM inventory_stock WHERE listing_id = $1`, [listingId]);
    if (hasStock) stock = await lockStock(tx, listingId);
  }
  const listing = await loadOwnListing(tx, ctx, listingId, { lock: true });
  const reserved =
    listing.status !== 'draft' &&
    (await maybeOne(tx, `SELECT 1 AS ok FROM reservations WHERE listing_id = $1 AND status IN ('active','payment_pending') LIMIT 1`, [listingId])) !== null;
  return { listing, stock, auction, hasActiveReservation: reserved, auctionHasBids: (auction?.bid_count ?? 0) > 0 };
}

export async function loadSchemaFor(db: Queryable, schemaVersionId: string): Promise<{ schema: AttributeSchema; version: number }> {
  const r = await maybeOne<{ schema: unknown; version: number }>(db, `SELECT schema, version FROM attribute_schema_versions WHERE id = $1`, [schemaVersionId]);
  if (!r) throw new DomainError('NOT_FOUND', 'Category schema not found.');
  return { schema: readAttributeSchema(r.schema), version: r.version };
}

export async function publishCandidate(db: Queryable, l: ListingRow, quantity: number): Promise<PublishCandidate> {
  const photos = await maybeOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM listing_media WHERE listing_id = $1`, [l.id]);
  const flaws = await many<{ description: string; media_id: string | null }>(
    db,
    `SELECT description, media_id FROM listing_flaws WHERE listing_id = $1 ORDER BY created_at, id`,
    [l.id],
  );
  return {
    title: l.title,
    description: l.description,
    saleMode: l.sale_mode,
    priceMinor: l.price_minor,
    minOfferMinor: l.min_offer_minor,
    condition: l.condition,
    flawsDeclaration: l.flaws_declaration,
    flaws: flaws.map((f) => ({ description: f.description, mediaId: f.media_id })),
    sizeSystem: l.size_system,
    sizeLabel: l.size_label,
    measurements: l.measurements ?? {},
    attributes: l.attributes ?? {},
    photoCount: photos?.n ?? 0,
    quantityMode: l.quantity_mode,
    quantity,
  };
}

/** JSON with sorted keys, so jsonb round-trips (which reorder keys) compare equal. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

/** What a buyer saw: written to listing_versions at publish and after every material change. */
export async function buildSnapshot(db: Queryable, listingId: string): Promise<Record<string, unknown>> {
  const l = await maybeOne<ListingRow>(
    db,
    `SELECT l.*, NULL::text AS shop_status, NULL::text AS shop_state, NULL::text AS shop_city FROM listings l WHERE l.id = $1`,
    [listingId],
  );
  if (!l) throw new DomainError('NOT_FOUND', 'Listing not found.');
  const media = await many<{ storage_key: string; role: string; caption: string | null; media_id: string }>(
    db,
    `SELECT m.storage_key, lm.role, lm.caption, lm.media_id FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id
      WHERE lm.listing_id = $1 ORDER BY lm.position`,
    [listingId],
  );
  const flaws = await many<{ description: string; location: string | null; severity: string; storage_key: string | null }>(
    db,
    `SELECT f.description, f.location, f.severity, m.storage_key FROM listing_flaws f LEFT JOIN media_assets m ON m.id = f.media_id
      WHERE f.listing_id = $1 ORDER BY f.created_at, f.id`,
    [listingId],
  );
  return {
    title: l.title,
    description: l.description,
    categoryId: l.category_id,
    schemaVersionId: l.schema_version_id,
    condition: l.condition,
    flawsDeclaration: l.flaws_declaration,
    flaws: flaws.map((f) => ({ description: f.description, location: f.location, severity: f.severity, mediaKey: f.storage_key })),
    sizeSystem: l.size_system,
    sizeLabel: l.size_label,
    measurements: l.measurements ?? {},
    attributes: l.attributes ?? {},
    brand: l.brand,
    colour: l.colour,
    material: l.material,
    priceMinor: l.price_minor,
    currency: 'NGN',
    saleMode: l.sale_mode,
    quantityMode: l.quantity_mode,
    media: media.map((m) => m.storage_key),
    mediaDetails: media.map((m) => ({ key: m.storage_key, role: m.role, caption: m.caption })),
  };
}

/**
 * Writes a new immutable listing_versions row (and bumps listings.version) when the buyer-visible snapshot
 * differs from the latest one. Returns the current version.
 */
export async function writeVersionIfChanged(tx: Queryable, listingId: string): Promise<{ version: number; changed: boolean }> {
  const snapshot = await buildSnapshot(tx, listingId);
  const latest = await maybeOne<{ version: number; snapshot: unknown }>(
    tx,
    `SELECT version, snapshot FROM listing_versions WHERE listing_id = $1 ORDER BY version DESC LIMIT 1`,
    [listingId],
  );
  const cur = await maybeOne<{ version: number }>(tx, `SELECT version FROM listings WHERE id = $1`, [listingId]);
  const listingVersion = cur?.version ?? 1;
  if (latest && stableStringify(latest.snapshot) === stableStringify(snapshot)) return { version: latest.version, changed: false };
  const version = latest ? Math.max(latest.version, listingVersion) + 1 : listingVersion;
  await tx.query(`INSERT INTO listing_versions (listing_id, version, snapshot) VALUES ($1, $2, $3)`, [listingId, version, JSON.stringify(snapshot)]);
  await tx.query(`UPDATE listings SET version = $2, updated_at = now() WHERE id = $1`, [listingId, version]);
  return { version, changed: true };
}

/** Listing status that matches recorded stock for an on-sale listing. */
export function statusFromStock(s: { quantityAvailable: number; quantityReserved: number; quantitySold: number }): 'active' | 'reserved' | 'sold' | 'ended' {
  if (s.quantityAvailable > 0) return 'active';
  if (s.quantityReserved > 0) return 'reserved';
  if (s.quantitySold > 0) return 'sold';
  return 'ended';
}
