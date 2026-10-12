import { assertPublishable, DomainError, editRestriction, isDomainError, shopCoversState, type ShopCoverage } from '@thrift/domain';
import { many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { requireOwnShop, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enqueue } from '../core/outbox';
import { enforceRateLimit } from '../core/rate-limit';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { initialiseStock, restock as restockAuthority, withdrawStock } from '../inventory/authority';
import { getCategory } from './categories';
import {
  bulkActionInput,
  createDraftInput,
  flawInput,
  flawsDeclarationInput,
  listingFieldsInput,
  listingIdInput,
  photosInput,
  quantityActionInput,
  removeFlawInput,
  updateFlawInput,
} from './inputs';
import {
  isUuid,
  lockForEdit,
  loadOwnListing,
  loadSchemaFor,
  publishCandidate,
  stableStringify,
  statusFromStock,
  writeVersionIfChanged,
  type EditLock,
  type ListingRow,
} from './internal';

type RestrictedField = Parameters<typeof editRestriction>[0]['field'];

function assertEditable(lock: EditLock, field: RestrictedField): void {
  const reason = editRestriction({
    status: lock.listing.status,
    hasActiveReservation: lock.hasActiveReservation,
    auctionHasBids: lock.auctionHasBids,
    field,
  });
  if (reason) throw new DomainError('INVALID_STATE', reason);
}

/** Auction lifecycle (schedule, cancel, relist) belongs to the auctions module once an auction exists. */
function assertNoLiveAuction(lock: EditLock, what: string): void {
  if (lock.auction && ['draft', 'scheduled', 'live', 'awaiting_payment'].includes(lock.auction.status)) {
    throw new DomainError('INVALID_STATE', `This piece has an auction (${lock.auction.status.replace('_', ' ')}). ${what} from the auction page instead.`);
  }
}

async function loadShopCoverage(db: Queryable, shopId: string): Promise<ShopCoverage> {
  const c = await maybeOne<{
    scope: ShopCoverage['scope'];
    states: string[];
    excluded_states: string[];
    offers_pickup: boolean;
    offers_seller_arranged: boolean;
    offers_integrated: boolean;
    same_city_fee_minor: number;
    same_state_fee_minor: number;
    interstate_fee_minor: number;
    transit_days_min: number;
    transit_days_max: number;
  }>(db, `SELECT * FROM delivery_coverage WHERE shop_id = $1`, [shopId]);
  return {
    scope: c?.scope ?? 'local',
    states: c?.states ?? [],
    excludedStates: c?.excluded_states ?? [],
    offersPickup: c?.offers_pickup ?? false,
    offersSellerArranged: c?.offers_seller_arranged ?? true,
    offersIntegrated: c?.offers_integrated ?? false,
    sameCityFeeMinor: c?.same_city_fee_minor ?? 150_000,
    sameStateFeeMinor: c?.same_state_fee_minor ?? 250_000,
    interstateFeeMinor: c?.interstate_fee_minor ?? 450_000,
    transitDaysMin: c?.transit_days_min ?? 1,
    transitDaysMax: c?.transit_days_max ?? 5,
  };
}

async function assertListableCategory(db: Queryable, categoryId: string, restrictedAcknowledged: boolean | undefined) {
  let cat;
  try {
    cat = await getCategory(db, categoryId);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') {
      throw new DomainError('VALIDATION_FAILED', 'Choose a category from the list.', { fieldErrors: { categoryId: 'Choose a category.' } });
    }
    throw err;
  }
  if (!cat.active) throw new DomainError('VALIDATION_FAILED', 'This category is no longer available.', { fieldErrors: { categoryId: 'Choose another category.' } });
  if (!cat.isLeaf) {
    throw new DomainError('VALIDATION_FAILED', `Choose a more specific category inside ${cat.name}.`, { fieldErrors: { categoryId: 'Choose a subcategory.' } });
  }
  if (cat.restricted && !restrictedAcknowledged) {
    throw new DomainError('VALIDATION_FAILED', `${cat.name} is a restricted category. Confirm the extra listing rules to continue.`, {
      fieldErrors: { restrictedAcknowledged: 'Confirm the restricted-category rules.' },
    });
  }
  return cat;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export async function createDraft(ctx: AppContext, raw: unknown): Promise<{ listingId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(createDraftInput, raw);
  await enforceRateLimit(ctx.pool, `listing-create:${user.userId}`, 300, 3600, 'You are creating listings very quickly. Wait a little and try again.');
  const shop = await requireOwnShop(ctx.pool, ctx);
  if (shop.status === 'suspended') throw new DomainError('INVALID_STATE', 'This shop is suspended. Contact support.');
  const cat = await assertListableCategory(ctx.pool, input.categoryId, input.restrictedAcknowledged);
  const l = await one<{ id: string }>(
    ctx.pool,
    `INSERT INTO listings (shop_id, category_id, schema_version_id, status, sale_mode, title, quantity_mode, initial_quantity)
     VALUES ($1, $2, $3, 'draft', $4, $5, 'unique', 1) RETURNING id`,
    [shop.id, cat.id, cat.schemaVersionId, input.saleMode, input.title],
  );
  return { listingId: l.id };
}

export interface UpdateListingResult {
  listingId: string;
  status: string;
  version: number;
  changed: string[];
}

type Mode = 'draft' | 'published' | 'any';

/**
 * Applies a partial edit. Drafts can change anything. Published listings follow the domain edit rules:
 * no price/condition/photo/quantity changes while reserved, sale-mode change only while paused, nothing after
 * sale/removal or after the first auction bid. Every buyer-visible change writes a new listing version.
 */
async function applyListingUpdate(ctx: AppContext, raw: unknown, mode: Mode): Promise<UpdateListingResult> {
  requireUser(ctx);
  const input = parseInput(listingFieldsInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    const isDraft = l.status === 'draft';
    if (mode === 'draft' && !isDraft) throw new DomainError('INVALID_STATE', 'This listing is already published. Edit it instead.');
    if (mode === 'published' && isDraft) throw new DomainError('INVALID_STATE', 'This listing is still a draft.');
    if (l.status === 'sold' || l.status === 'removed') throw new DomainError('INVALID_STATE', 'This listing can no longer be edited.');

    const changed = new Set<string>();
    const restricted = new Set<RestrictedField>();
    const next = { ...l };
    const set = <K extends keyof ListingRow>(key: K, value: ListingRow[K], label: string, field: RestrictedField | null) => {
      const same = typeof value === 'object' && value !== null ? stableStringify(value) === stableStringify(l[key]) : value === l[key];
      if (same) return;
      next[key] = value;
      changed.add(label);
      if (field) restricted.add(field);
    };

    if (input.title !== undefined) set('title', input.title, 'title', 'title');
    if (input.description !== undefined) set('description', input.description ?? '', 'description', 'description');
    if (input.brand !== undefined) set('brand', input.brand, 'brand', 'description');
    if (input.colour !== undefined) set('colour', input.colour, 'colour', 'description');
    if (input.material !== undefined) set('material', input.material, 'material', 'description');
    if (input.attributes !== undefined) set('attributes', input.attributes, 'attributes', 'description');
    // Size, measurements and flaws describe the physical piece: treated like condition (locked while reserved).
    if (input.sizeSystem !== undefined) set('size_system', input.sizeSystem, 'size', 'condition');
    if (input.sizeLabel !== undefined) set('size_label', input.sizeLabel, 'size', 'condition');
    if (input.measurements !== undefined) set('measurements', input.measurements, 'measurements', 'condition');
    if (input.condition !== undefined) set('condition', input.condition, 'condition', 'condition');
    if (input.flawsDeclaration !== undefined) set('flaws_declaration', input.flawsDeclaration, 'flaws', 'condition');
    if (input.saleMode !== undefined) set('sale_mode', input.saleMode, 'saleMode', 'saleMode');
    if (input.price !== undefined) set('price_minor', input.price, 'price', 'price');
    if (input.minOffer !== undefined) set('min_offer_minor', input.minOffer, 'minOffer', 'price');
    if (input.quantityMode !== undefined) set('quantity_mode', input.quantityMode, 'quantityMode', 'quantity');
    if (input.quantity !== undefined) set('initial_quantity', input.quantity, 'quantity', 'quantity');
    if (input.deliveryStates !== undefined) set('delivery_states', input.deliveryStates.length > 0 ? [...input.deliveryStates].sort() : null, 'deliveryStates', null);
    if (input.weightGrams !== undefined) set('weight_grams', input.weightGrams, 'weight', null);
    if (input.batchId !== undefined) set('batch_id', input.batchId, 'batch', null);
    if (input.categoryId !== undefined && input.categoryId !== l.category_id) {
      if (!isDraft) throw new DomainError('INVALID_STATE', 'The category cannot change after publishing. Duplicate the listing to list it in another category.');
      const cat = await assertListableCategory(tx, input.categoryId, input.restrictedAcknowledged);
      next.category_id = cat.id;
      next.schema_version_id = cat.schemaVersionId;
      changed.add('category');
    }

    // ---- Published-listing rules -------------------------------------------------------------
    if (!isDraft) {
      if (changed.has('quantity') || changed.has('quantityMode')) {
        throw new DomainError('INVALID_STATE', 'Quantity cannot be edited after publishing. Use Restock for identical units, or Mark sold elsewhere.');
      }
      if (changed.has('saleMode') && (l.sale_mode === 'auction' || next.sale_mode === 'auction')) {
        throw new DomainError('INVALID_STATE', 'Published pieces cannot switch to or from auction. Fixed-price and auction sales are kept separate — schedule a new auction from the auctions page.');
      }
      if (l.sale_mode === 'auction' && changed.has('price')) {
        throw new DomainError('INVALID_STATE', 'Auction prices are set on the auction itself.');
      }
      for (const f of restricted) assertEditable(lock, f);
    }

    // ---- Cross-field validation against the listing's schema version ------------------------------
    const { schema } = await loadSchemaFor(tx, next.schema_version_id);
    const fieldErrors: Record<string, string> = {};
    if (changed.has('category')) {
      // Keep only measurements/attributes the new schema knows about.
      next.measurements = Object.fromEntries(Object.entries(next.measurements ?? {}).filter(([k]) => schema.measurements.some((m) => m.key === k)));
      next.attributes = Object.fromEntries(Object.entries(next.attributes ?? {}).filter(([k]) => schema.attributes.some((a) => a.key === k)));
      if (next.size_system && !schema.allowedSizeSystems.includes(next.size_system)) next.size_system = null;
    }
    for (const key of Object.keys(input.measurements ?? {})) {
      if (!schema.measurements.some((m) => m.key === key)) fieldErrors[`measurements.${key}`] = 'This measurement does not apply to the category.';
    }
    for (const [key, value] of Object.entries(input.attributes ?? {})) {
      const def = schema.attributes.find((a) => a.key === key);
      if (!def) fieldErrors[`attributes.${key}`] = 'This detail does not apply to the category.';
      else if (def.type === 'select' && def.options && !def.options.includes(value)) fieldErrors[`attributes.${key}`] = `Choose one of: ${def.options.join(', ')}.`;
    }
    if (input.sizeSystem && schema.allowedSizeSystems.length > 0 && !schema.allowedSizeSystems.includes(input.sizeSystem)) {
      fieldErrors.sizeSystem = 'Choose a size system that fits this category.';
    }
    if (next.sale_mode === 'auction' && next.quantity_mode === 'equivalent') {
      fieldErrors.quantityMode = 'Auctions cover one identified piece. Choose “Unique piece”.';
    }
    if (next.quantity_mode === 'unique') next.initial_quantity = 1;
    if (next.sale_mode !== 'negotiable' && next.min_offer_minor !== null) {
      next.min_offer_minor = null; // a private minimum only applies to negotiable listings
    }
    if (next.min_offer_minor !== null) {
      if (next.price_minor === null) fieldErrors.minOffer = 'Set the asking price first.';
      else if (next.min_offer_minor > next.price_minor) fieldErrors.minOffer = 'Your private minimum cannot be above the asking price.';
    }
    if (next.flaws_declaration === 'none_known') {
      const flawCount = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM listing_flaws WHERE listing_id = $1`, [l.id]);
      if (flawCount.n > 0) fieldErrors.flawsDeclaration = 'You have listed flaws. Remove them first, or choose “Yes — described below”.';
    }
    if (input.deliveryStates !== undefined && input.deliveryStates.length > 0) {
      const cov = await loadShopCoverage(tx, l.shop_id);
      const outside = input.deliveryStates.filter((s) => !shopCoversState(cov, l.shop_state, s, null));
      if (outside.length > 0) fieldErrors.deliveryStates = `Outside your shop’s delivery coverage: ${outside.join(', ')}.`;
    }
    if (input.batchId) {
      const own = await maybeOne(tx, `SELECT 1 AS ok FROM batches WHERE id = $1 AND shop_id = $2`, [input.batchId, l.shop_id]);
      if (!own) fieldErrors.batchId = 'Choose one of your batches.';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new DomainError('VALIDATION_FAILED', Object.values(fieldErrors)[0]!, { fieldErrors });
    }

    // Scheduled pieces moved out of a future drop go on sale now.
    let status: ListingRow['status'] = l.status;
    if (l.status === 'scheduled' && changed.has('batch')) {
      const drop = next.batch_id
        ? await maybeOne<{ drop_at: Date | null }>(tx, `SELECT drop_at FROM batches WHERE id = $1`, [next.batch_id])
        : null;
      if (!drop?.drop_at || new Date(drop.drop_at).getTime() <= ctx.now().getTime()) status = lock.stock ? statusFromStock(lock.stock) : 'active';
    }

    await tx.query(
      `UPDATE listings SET
         category_id = $2, schema_version_id = $3, title = $4, description = $5, brand = $6, colour = $7, material = $8,
         size_system = $9, size_label = $10, measurements = $11, attributes = $12, condition = $13,
         flaws_declaration = $14, flaws_affirmed_at = CASE WHEN $14::text IS DISTINCT FROM flaws_declaration THEN (CASE WHEN $14::text IS NULL THEN NULL ELSE now() END) ELSE flaws_affirmed_at END,
         sale_mode = $15, price_minor = $16, min_offer_minor = $17, quantity_mode = $18, initial_quantity = $19,
         delivery_states = $20, weight_grams = $21, batch_id = $22, status = $23,
         published_at = CASE WHEN $23 <> status AND status = 'scheduled' THEN now() ELSE published_at END,
         updated_at = now()
       WHERE id = $1`,
      [
        l.id,
        next.category_id,
        next.schema_version_id,
        next.title,
        next.description,
        next.brand,
        next.colour,
        next.material,
        next.size_system,
        next.size_label,
        JSON.stringify(next.measurements ?? {}),
        JSON.stringify(next.attributes ?? {}),
        next.condition,
        next.flaws_declaration,
        next.sale_mode,
        next.price_minor,
        next.min_offer_minor,
        next.quantity_mode,
        next.initial_quantity,
        next.delivery_states,
        next.weight_grams,
        next.batch_id,
        status,
      ],
    );
    let version = l.version;
    if (!isDraft) version = (await writeVersionIfChanged(tx, l.id)).version;
    return { listingId: l.id, status, version, changed: [...changed] };
  });
}

/** Edits a draft (anything can change). */
export function updateDraft(ctx: AppContext, raw: unknown): Promise<UpdateListingResult> {
  return applyListingUpdate(ctx, raw, 'draft');
}

/** Edits a published listing under the domain edit restrictions; material changes write a new version. */
export function editPublishedListing(ctx: AppContext, raw: unknown): Promise<UpdateListingResult> {
  return applyListingUpdate(ctx, raw, 'published');
}

/** Draft or published: dispatches to the right rules (used by the listing editor). */
export function updateListing(ctx: AppContext, raw: unknown): Promise<UpdateListingResult> {
  return applyListingUpdate(ctx, raw, 'any');
}

// ---------------------------------------------------------------------------
// Photos and flaws
// ---------------------------------------------------------------------------

/** Replaces the ordered photo set. Photos must be the seller's own uploads with purpose 'listing'. */
export async function setListingPhotos(ctx: AppContext, raw: unknown): Promise<{ listingId: string; count: number; version: number }> {
  const user = requireUser(ctx);
  const input = parseInput(photosInput, raw);
  const settings = await getSettings(ctx.pool);
  if (input.photos.length > settings.max_listing_photos) {
    throw new DomainError('VALIDATION_FAILED', `Use at most ${settings.max_listing_photos} photos.`, { fieldErrors: { photos: `At most ${settings.max_listing_photos} photos.` } });
  }
  const ids = input.photos.map((p) => p.mediaId);
  if (new Set(ids).size !== ids.length) throw new DomainError('VALIDATION_FAILED', 'The same photo is included twice.');
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.status !== 'draft') assertEditable(lock, 'photos');
    if (ids.length > 0) {
      const owned = await many<{ id: string }>(
        tx,
        `SELECT id FROM media_assets WHERE id = ANY($1::uuid[]) AND owner_user_id = $2 AND purpose = 'listing' AND status = 'ready'`,
        [ids, user.userId],
      );
      if (owned.length !== ids.length) throw new DomainError('NOT_FOUND', 'A photo was not found. Upload it again.', { fieldErrors: { photos: 'Upload the missing photo again.' } });
    }
    await tx.query(`DELETE FROM listing_media WHERE listing_id = $1`, [l.id]);
    for (const [position, p] of input.photos.entries()) {
      await tx.query(`INSERT INTO listing_media (listing_id, media_id, position, role, caption) VALUES ($1, $2, $3, $4, $5)`, [l.id, p.mediaId, position, p.role, p.caption]);
    }
    await tx.query(`UPDATE listings SET updated_at = now() WHERE id = $1`, [l.id]);
    const version = l.status === 'draft' ? l.version : (await writeVersionIfChanged(tx, l.id)).version;
    return { listingId: l.id, count: input.photos.length, version };
  });
}

/** A flaw photo must be one of the listing's photos or another of the seller's own listing uploads. */
async function assertFlawPhoto(tx: Queryable, userId: string, listingId: string, mediaId: string | null): Promise<void> {
  if (!mediaId) return;
  const ok = await maybeOne(
    tx,
    `SELECT 1 AS ok FROM media_assets m
      WHERE m.id = $1 AND m.status = 'ready'
        AND (EXISTS (SELECT 1 FROM listing_media lm WHERE lm.listing_id = $2 AND lm.media_id = m.id)
             OR (m.owner_user_id = $3 AND m.purpose = 'listing'))`,
    [mediaId, listingId, userId],
  );
  if (!ok) throw new DomainError('NOT_FOUND', 'That photo was not found. Choose one of this listing’s photos.', { fieldErrors: { mediaId: 'Choose a photo.' } });
}

async function afterFlawChange(tx: Queryable, l: ListingRow): Promise<number> {
  await tx.query(`UPDATE listings SET updated_at = now() WHERE id = $1`, [l.id]);
  return l.status === 'draft' ? l.version : (await writeVersionIfChanged(tx, l.id)).version;
}

export async function addFlaw(ctx: AppContext, raw: unknown): Promise<{ flawId: string; version: number }> {
  const user = requireUser(ctx);
  const input = parseInput(flawInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.status !== 'draft') assertEditable(lock, 'condition');
    const count = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM listing_flaws WHERE listing_id = $1`, [l.id]);
    if (count.n >= 20) throw new DomainError('VALIDATION_FAILED', 'Describe at most 20 flaws. Group similar wear together.');
    await assertFlawPhoto(tx, user.userId, l.id, input.mediaId);
    const f = await one<{ id: string }>(
      tx,
      `INSERT INTO listing_flaws (listing_id, description, location, severity, media_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [l.id, input.description, input.location, input.severity, input.mediaId],
    );
    // Describing a flaw is the declaration that flaws exist.
    if (l.flaws_declaration !== 'described') {
      await tx.query(`UPDATE listings SET flaws_declaration = 'described', flaws_affirmed_at = now() WHERE id = $1`, [l.id]);
    }
    return { flawId: f.id, version: await afterFlawChange(tx, l) };
  });
}

export async function updateFlaw(ctx: AppContext, raw: unknown): Promise<{ flawId: string; version: number }> {
  const user = requireUser(ctx);
  const input = parseInput(updateFlawInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.status !== 'draft') assertEditable(lock, 'condition');
    await assertFlawPhoto(tx, user.userId, l.id, input.mediaId);
    const res = await tx.query(
      `UPDATE listing_flaws SET description = $3, location = $4, severity = $5, media_id = $6 WHERE id = $1 AND listing_id = $2`,
      [input.flawId, l.id, input.description, input.location, input.severity, input.mediaId],
    );
    if (!res.rowCount) throw new DomainError('NOT_FOUND', 'Flaw not found.');
    return { flawId: input.flawId, version: await afterFlawChange(tx, l) };
  });
}

export async function removeFlaw(ctx: AppContext, raw: unknown): Promise<{ version: number }> {
  requireUser(ctx);
  const input = parseInput(removeFlawInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.status !== 'draft') assertEditable(lock, 'condition');
    const res = await tx.query(`DELETE FROM listing_flaws WHERE id = $1 AND listing_id = $2`, [input.flawId, l.id]);
    if (!res.rowCount) throw new DomainError('NOT_FOUND', 'Flaw not found.');
    return { version: await afterFlawChange(tx, l) };
  });
}

/** Seller affirms "no known flaws" or "flaws described below". */
export async function affirmFlawsDeclaration(ctx: AppContext, raw: unknown): Promise<UpdateListingResult> {
  const input = parseInput(flawsDeclarationInput, raw);
  return updateListing(ctx, { listingId: input.listingId, flawsDeclaration: input.declaration });
}

// ---------------------------------------------------------------------------
// Publishing and status changes
// ---------------------------------------------------------------------------

export interface PublishResult {
  listingId: string;
  status: 'active' | 'scheduled';
  version: number;
  dropAt: string | null;
}

/**
 * Publishes a draft: runs the pre-publication checklist against the listing's own schema version, creates
 * its stock row through the inventory authority and writes version 1. Auction pieces are published by
 * scheduling the auction instead. Listings in a batch with a future drop time become 'scheduled'.
 */
export async function publishListing(ctx: AppContext, raw: unknown): Promise<PublishResult> {
  requireUser(ctx);
  const input = parseInput(listingIdInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const l = await loadOwnListing(tx, ctx, input.listingId, { lock: true });
    if (l.status === 'active' || l.status === 'scheduled') {
      return { listingId: l.id, status: l.status, version: l.version, dropAt: null };
    }
    if (l.status !== 'draft') throw new DomainError('INVALID_STATE', 'Only drafts can be published. Resume a paused listing instead.');
    if (l.sale_mode === 'auction') {
      throw new DomainError(
        'INVALID_STATE',
        'Auction pieces go live by scheduling the auction. Open “Schedule auction” to set the start time, opening price and bid increment.',
        { action: 'schedule_auction', listingId: l.id },
      );
    }
    if (l.shop_status !== 'active') {
      throw new DomainError(
        'INVALID_STATE',
        l.shop_status === 'draft'
          ? 'Finish setting up and open your shop before publishing listings.'
          : l.shop_status === 'paused'
            ? 'Your shop is paused. Resume it to publish new listings.'
            : 'This shop is suspended. Contact support.',
      );
    }
    const { schema } = await loadSchemaFor(tx, l.schema_version_id);
    const quantity = l.quantity_mode === 'unique' ? 1 : l.initial_quantity;
    assertPublishable(await publishCandidate(tx, l, quantity), schema);
    let status: 'active' | 'scheduled' = 'active';
    let dropAt: Date | null = null;
    if (l.batch_id) {
      const b = await maybeOne<{ drop_at: Date | null; drop_announced_at: Date | null }>(tx, `SELECT drop_at, drop_announced_at FROM batches WHERE id = $1`, [l.batch_id]);
      if (b?.drop_at && !b.drop_announced_at && new Date(b.drop_at).getTime() > ctx.now().getTime()) {
        status = 'scheduled';
        dropAt = new Date(b.drop_at);
      }
    }
    await initialiseStock(tx, l.id, quantity);
    await tx.query(
      `UPDATE listings SET status = $2, published_at = CASE WHEN $2 = 'active' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`,
      [l.id, status],
    );
    const { version } = await writeVersionIfChanged(tx, l.id);
    if (status === 'active') {
      await enqueue(tx, { topic: 'listing.published', aggregateId: l.id, payload: { listingId: l.id, shopId: l.shop_id }, dedupeKey: `listing.published:${l.id}` });
    }
    return { listingId: l.id, status, version, dropAt: dropAt?.toISOString() ?? null };
  });
}

/** Paused listings leave discovery and cannot be bought; a reserved piece cannot be paused mid-checkout. */
export async function pauseListing(ctx: AppContext, raw: unknown): Promise<{ listingId: string; status: string }> {
  requireUser(ctx);
  const input = parseInput(listingIdInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.status === 'paused') return { listingId: l.id, status: 'paused' };
    assertNoLiveAuction(lock, 'Manage it');
    if (l.status === 'reserved') throw new DomainError('INVALID_STATE', 'This item is reserved for a buyer; wait for the reservation to finish.');
    if (l.status !== 'active' && l.status !== 'scheduled') throw new DomainError('INVALID_STATE', 'Only listings that are on sale or scheduled can be paused.');
    await tx.query(`UPDATE listings SET status = 'paused', updated_at = now() WHERE id = $1`, [l.id]);
    return { listingId: l.id, status: 'paused' };
  });
}

export async function resumeListing(ctx: AppContext, raw: unknown): Promise<{ listingId: string; status: string }> {
  requireUser(ctx);
  const input = parseInput(listingIdInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.status !== 'paused') {
      if (['active', 'reserved', 'scheduled'].includes(l.status)) return { listingId: l.id, status: l.status };
      throw new DomainError('INVALID_STATE', 'Only paused listings can be resumed.');
    }
    if (!lock.stock) throw new DomainError('INVALID_STATE', 'This listing has no stock record. Duplicate it to list again.');
    let status: string = statusFromStock(lock.stock);
    if (l.batch_id && status === 'active') {
      const b = await maybeOne<{ drop_at: Date | null; drop_announced_at: Date | null }>(tx, `SELECT drop_at, drop_announced_at FROM batches WHERE id = $1`, [l.batch_id]);
      if (b?.drop_at && !b.drop_announced_at && new Date(b.drop_at).getTime() > ctx.now().getTime()) status = 'scheduled';
    }
    await tx.query(
      `UPDATE listings SET status = $2, published_at = CASE WHEN $2 = 'active' THEN coalesce(published_at, now()) ELSE published_at END, updated_at = now() WHERE id = $1`,
      [l.id, status],
    );
    return { listingId: l.id, status };
  });
}

/**
 * Seller sold units outside the platform. Goes through the inventory authority (withdrawStock), so only
 * available units can be withdrawn — never units reserved for a buyer.
 */
export async function markSoldElsewhere(ctx: AppContext, raw: unknown): Promise<{ listingId: string; status: string; quantityAvailable: number }> {
  const user = requireUser(ctx);
  const input = parseInput(quantityActionInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.status === 'draft') throw new DomainError('INVALID_STATE', 'This listing is not published. Remove the draft instead.');
    if (['sold', 'removed', 'ended'].includes(l.status)) throw new DomainError('INVALID_STATE', 'There are no available units left on this listing.');
    assertNoLiveAuction(lock, 'Cancel it');
    if (l.quantity_mode === 'unique' && input.quantity !== 1) throw new DomainError('VALIDATION_FAILED', 'A unique piece has a quantity of one.');
    const stock = await withdrawStock(tx, { listingId: l.id, quantity: input.quantity, reason: 'sold_elsewhere', actorUserId: user.userId });
    let status = (await one<{ status: string }>(tx, `SELECT status FROM listings WHERE id = $1`, [l.id])).status;
    if (stock.quantityAvailable === 0 && stock.quantityReserved === 0 && ['paused', 'scheduled'].includes(status)) {
      await tx.query(`UPDATE listings SET status = 'ended', updated_at = now() WHERE id = $1`, [l.id]);
      status = 'ended';
    }
    if (status === 'ended') {
      await enqueue(tx, { topic: 'listing.ended', aggregateId: l.id, payload: { listingId: l.id, shopId: l.shop_id, reason: 'sold_elsewhere' }, dedupeKey: `listing.ended:${l.id}:${stock.version}` });
    }
    return { listingId: l.id, status, quantityAvailable: stock.quantityAvailable };
  });
}

/** Adds genuinely identical units (equivalent-unit listings only) through the inventory authority. */
export async function restockListing(ctx: AppContext, raw: unknown): Promise<{ listingId: string; status: string; quantityAvailable: number }> {
  const user = requireUser(ctx);
  const input = parseInput(quantityActionInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.quantity_mode !== 'equivalent') {
      throw new DomainError('INVALID_STATE', 'Only listings of identical units can be restocked. List a different piece as its own listing.');
    }
    if (l.status === 'draft') throw new DomainError('INVALID_STATE', 'Set the quantity on the draft before publishing.');
    if (l.status === 'removed') throw new DomainError('INVALID_STATE', 'This listing was removed.');
    if (!lock.stock) throw new DomainError('INVALID_STATE', 'This listing has no stock record.');
    if (lock.stock.quantityAvailable + lock.stock.quantityReserved + input.quantity > 500) {
      throw new DomainError('VALIDATION_FAILED', 'A listing can hold at most 500 units on sale at once.', { fieldErrors: { quantity: 'Too many units.' } });
    }
    const stock = await restockAuthority(tx, { listingId: l.id, quantity: input.quantity, actorUserId: user.userId });
    let status = (await one<{ status: string }>(tx, `SELECT status FROM listings WHERE id = $1`, [l.id])).status;
    if (status === 'ended' || status === 'sold') {
      status = 'active';
      await tx.query(`UPDATE listings SET status = 'active', sold_at = NULL, updated_at = now() WHERE id = $1`, [l.id]);
    }
    return { listingId: l.id, status, quantityAvailable: stock.quantityAvailable };
  });
}

/** Removes a listing from sale permanently. Not allowed while a buyer holds a reservation. */
export async function removeListing(ctx: AppContext, raw: unknown): Promise<{ listingId: string; status: 'removed' }> {
  const user = requireUser(ctx);
  const input = parseInput(listingIdInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const lock = await lockForEdit(tx, ctx, input.listingId);
    const l = lock.listing;
    if (l.status === 'removed') return { listingId: l.id, status: 'removed' as const };
    if (lock.hasActiveReservation) throw new DomainError('INVALID_STATE', 'This item is reserved for a buyer; wait for the reservation to finish before removing it.');
    assertNoLiveAuction(lock, 'Cancel it');
    if (l.status === 'sold') throw new DomainError('INVALID_STATE', 'Sold listings stay on record for the buyer and cannot be removed.');
    if (lock.stock && lock.stock.quantityAvailable > 0) {
      await withdrawStock(tx, { listingId: l.id, quantity: lock.stock.quantityAvailable, reason: 'listing_removed', actorUserId: user.userId });
    }
    await tx.query(`UPDATE listings SET status = 'removed', updated_at = now() WHERE id = $1`, [l.id]);
    if (l.status !== 'draft') {
      await enqueue(tx, { topic: 'listing.ended', aggregateId: l.id, payload: { listingId: l.id, shopId: l.shop_id, reason: 'removed' }, dedupeKey: `listing.ended:${l.id}:removed` });
    }
    return { listingId: l.id, status: 'removed' as const };
  });
}

/**
 * Copies descriptive fields into a new draft. Photos, flaws, the flaw declaration and the condition grade are
 * NOT copied: every piece must be photographed and graded on its own.
 */
export async function duplicateListing(ctx: AppContext, raw: unknown): Promise<{ listingId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(listingIdInput, raw);
  await enforceRateLimit(ctx.pool, `listing-create:${user.userId}`, 300, 3600);
  const src = await loadOwnListing(ctx.pool, ctx, input.listingId);
  if (src.shop_status === 'suspended') throw new DomainError('INVALID_STATE', 'This shop is suspended. Contact support.');
  const cat = await getCategory(ctx.pool, src.category_id);
  const title = src.title.length <= 83 ? `${src.title} (copy)` : src.title;
  const row = await one<{ id: string }>(
    ctx.pool,
    `INSERT INTO listings (shop_id, category_id, schema_version_id, batch_id, status, sale_mode, title, description, brand, colour, material,
                           size_system, size_label, measurements, attributes, quantity_mode, initial_quantity, price_minor, min_offer_minor,
                           delivery_states, weight_grams)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
    [
      src.shop_id,
      cat.id,
      cat.schemaVersionId,
      src.batch_id,
      src.sale_mode,
      title,
      src.description,
      src.brand,
      src.colour,
      src.material,
      src.size_system,
      src.size_label,
      JSON.stringify(src.measurements ?? {}),
      JSON.stringify(src.attributes ?? {}),
      src.quantity_mode,
      src.initial_quantity,
      src.price_minor,
      src.sale_mode === 'negotiable' ? src.min_offer_minor : null,
      src.delivery_states,
      src.weight_grams,
    ],
  );
  return { listingId: row.id };
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

export interface BulkItemResult {
  listingId: string;
  ok: boolean;
  status?: string;
  message: string;
}

/**
 * Applies pause / resume / mark-sold-elsewhere to many of the seller's own listings. Each item runs in its
 * own transaction; listings that are not the caller's report "Not found". "Mark sold elsewhere" withdraws one
 * unit per listing.
 */
export async function bulkListingAction(ctx: AppContext, raw: unknown): Promise<{ results: BulkItemResult[]; succeeded: number; failed: number }> {
  const user = requireUser(ctx);
  const input = parseInput(bulkActionInput, raw);
  await enforceRateLimit(ctx.pool, `listing-bulk:${user.userId}`, 60, 3600);
  const results: BulkItemResult[] = [];
  for (const listingId of input.listingIds) {
    if (!isUuid(listingId)) {
      results.push({ listingId, ok: false, message: 'Not found.' });
      continue;
    }
    try {
      const r =
        input.action === 'pause'
          ? await pauseListing(ctx, { listingId })
          : input.action === 'resume'
            ? await resumeListing(ctx, { listingId })
            : await markSoldElsewhere(ctx, { listingId, quantity: 1 });
      results.push({
        listingId,
        ok: true,
        status: r.status,
        message: input.action === 'pause' ? 'Paused.' : input.action === 'resume' ? 'Back on sale.' : 'Marked sold elsewhere.',
      });
    } catch (err) {
      if (!isDomainError(err)) throw err;
      results.push({ listingId, ok: false, message: err.code === 'NOT_FOUND' ? 'Not found.' : err.message });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}
