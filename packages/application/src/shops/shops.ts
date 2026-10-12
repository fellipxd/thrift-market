import { coarsenCoordinate, DomainError, shopCoversState, slugify } from '@thrift/domain';
import { isUniqueViolation, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { findOwnShop, requireOwnShop, requireUser, requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { parseInput } from '../core/validation';
import { coverageInput, pauseShopInput, shopProfileInput } from './inputs';
import { computeChecklist } from './checklist';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export interface ApproxLocation {
  lat: number;
  lng: number;
  precision: 'city' | 'area';
}

/**
 * Approximate public location for a shop: the centroid of the chosen area, else the city, else the state,
 * from the reference `places` table, coarsened to ~1 km. We never ask for or store a seller's home address.
 */
export async function geocodeApproximate(db: Queryable, args: { state: string; city: string; area: string | null }): Promise<ApproxLocation | null> {
  type P = { lat: number; lng: number; kind: string; [k: string]: unknown };
  const find = (name: string, kinds: string[]) =>
    maybeOne<P>(
      db,
      `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, kind
         FROM places WHERE state = $1 AND lower(name) = lower($2) AND kind = ANY($3)
        ORDER BY kind = 'area' DESC, population_rank LIMIT 1`,
      [args.state, name.trim(), kinds],
    );
  let precision: ApproxLocation['precision'] = 'city';
  let place: P | null = null;
  if (args.area) {
    place = await find(args.area, ['area']);
    if (place) precision = 'area';
  }
  if (!place) place = await find(args.city, ['city', 'area']);
  if (!place) place = await find(args.state, ['state']);
  if (!place) return null;
  return { lat: coarsenCoordinate(place.lat), lng: coarsenCoordinate(place.lng), precision };
}

function slugCandidate(name: string, attempt: number): string {
  let base = slugify(name, 40);
  if (!SLUG_RE.test(base)) base = `shop-${Math.random().toString(36).slice(2, 6)}`;
  if (attempt === 0) return base;
  const suffix = attempt < 3 ? String(attempt + 1) : Math.random().toString(36).slice(2, 6);
  return `${base.slice(0, 40 - suffix.length - 1).replace(/-+$/g, '')}-${suffix}`;
}

/** Picks the first free slug: "abuja-wardrobe", then "abuja-wardrobe-2", "-3", … */
async function allocateSlug(db: Queryable, name: string, salt: number): Promise<string> {
  const base = slugCandidate(name, 0);
  if (salt > 0) return slugCandidate(name, 3 + salt); // random suffix after a race
  const taken = new Set(
    (await db.query<{ slug: string }>(`SELECT slug FROM shops WHERE slug = $1 OR slug LIKE $2`, [base, `${base.slice(0, 36)}%`])).rows.map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 200; n++) {
    const suffix = String(n);
    const candidate = `${base.slice(0, 40 - suffix.length - 1).replace(/-+$/g, '')}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return slugCandidate(name, 9);
}

export interface CreateShopResult {
  shopId: string;
  slug: string;
}

/**
 * Seller onboarding step 1. One shop per user. The shop starts as a draft and is published once its
 * profile, delivery coverage and payout account are in place (publishShop).
 */
export async function createShop(ctx: AppContext, raw: unknown): Promise<CreateShopResult> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(shopProfileInput, raw);
  await enforceRateLimit(ctx.pool, `shop-create:${user.userId}`, 10, 3600);
  if (await findOwnShop(ctx.pool, user.userId)) {
    throw new DomainError('CONFLICT', 'You already have a shop. Manage it from your seller workspace.');
  }
  const loc = await geocodeApproximate(ctx.pool, input);
  for (let attempt = 0; ; attempt++) {
    const slug = await allocateSlug(ctx.pool, input.name, attempt);
    try {
      return await withTransaction(ctx.pool, async (tx) => {
        const shop = await one<{ id: string }>(
          tx,
          `INSERT INTO shops (slug, name, bio, owner_user_id, status, city, state, area, location, location_precision, returns_policy, dispatch_days)
           VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7,
                   CASE WHEN $8::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($9::float8, $8::float8), 4326)::geography END,
                   $10, $11, $12)
           RETURNING id`,
          [slug, input.name, input.bio, user.userId, input.city, input.state, input.area, loc?.lat ?? null, loc?.lng ?? null, loc?.precision ?? 'city', input.returnsPolicy, input.dispatchDays],
        );
        await tx.query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, 'owner')`, [shop.id, user.userId]);
        // Default coverage: local seller-arranged delivery. The seller confirms or changes it during onboarding
        // (the checklist treats coverage as done once it has been saved after creation).
        await tx.query(`INSERT INTO delivery_coverage (shop_id, scope, offers_seller_arranged) VALUES ($1, 'local', true)`, [shop.id]);
        await recordAudit(tx, ctx, { action: 'shop.created', targetKind: 'shop', targetId: shop.id, data: { slug } });
        return { shopId: shop.id, slug };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'shops_owner_user_id_key')) {
        throw new DomainError('CONFLICT', 'You already have a shop. Manage it from your seller workspace.');
      }
      if (isUniqueViolation(err, 'shops_slug_key') && attempt < 4) continue;
      throw err;
    }
  }
}

/** Profile edits keep the slug stable so shared links and QR codes never break. */
export async function updateShopProfile(ctx: AppContext, raw: unknown): Promise<{ shopId: string }> {
  requireUser(ctx);
  const input = parseInput(shopProfileInput, raw);
  const shop = await requireOwnShop(ctx.pool, ctx);
  if (shop.status === 'suspended') throw new DomainError('INVALID_STATE', 'This shop is suspended. Contact support.');
  const loc = await geocodeApproximate(ctx.pool, input);
  await withTransaction(ctx.pool, async (tx) => {
    await tx.query(
      `UPDATE shops SET name = $2, bio = $3, city = $4, state = $5, area = $6,
              location = CASE WHEN $7::float8 IS NULL THEN location ELSE ST_SetSRID(ST_MakePoint($8::float8, $7::float8), 4326)::geography END,
              location_precision = CASE WHEN $7::float8 IS NULL THEN location_precision ELSE $9 END,
              returns_policy = $10, dispatch_days = $11, updated_at = now()
        WHERE id = $1`,
      [shop.id, input.name, input.bio, input.city, input.state, input.area, loc?.lat ?? null, loc?.lng ?? null, loc?.precision ?? 'city', input.returnsPolicy, input.dispatchDays],
    );
  });
  return { shopId: shop.id };
}

export async function updateDeliveryCoverage(ctx: AppContext, raw: unknown): Promise<{ shopId: string }> {
  requireUser(ctx);
  const input = parseInput(coverageInput, raw);
  const shop = await requireOwnShop(ctx.pool, ctx);
  if (shop.status === 'suspended') throw new DomainError('INVALID_STATE', 'This shop is suspended. Contact support.');
  const states = input.scope === 'states' ? input.states.filter((s) => s !== shop.state) : [];
  const excluded = input.scope === 'local' ? [] : input.excludedStates;
  if (excluded.includes(shop.state)) {
    throw new DomainError('VALIDATION_FAILED', 'You cannot exclude your own state.', { fieldErrors: { excludedStates: `Your shop is in ${shop.state}.` } });
  }
  if (input.scope === 'states' && states.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'Choose at least one state besides your own, or choose “My state only”.', {
      fieldErrors: { states: 'Choose at least one other state.' },
    });
  }
  const overlap = excluded.filter((s) => states.includes(s));
  if (overlap.length > 0) {
    throw new DomainError('VALIDATION_FAILED', `${overlap.join(', ')} cannot be both included and excluded.`, { fieldErrors: { excludedStates: 'Remove the overlap.' } });
  }
  await withTransaction(ctx.pool, async (tx) => {
    await tx.query(
      `INSERT INTO delivery_coverage (shop_id, scope, states, excluded_states, offers_pickup, offers_seller_arranged, offers_integrated,
                                      same_city_fee_minor, same_state_fee_minor, interstate_fee_minor, transit_days_min, transit_days_max, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT (shop_id) DO UPDATE SET
         scope = EXCLUDED.scope, states = EXCLUDED.states, excluded_states = EXCLUDED.excluded_states,
         offers_pickup = EXCLUDED.offers_pickup, offers_seller_arranged = EXCLUDED.offers_seller_arranged,
         offers_integrated = EXCLUDED.offers_integrated, same_city_fee_minor = EXCLUDED.same_city_fee_minor,
         same_state_fee_minor = EXCLUDED.same_state_fee_minor, interstate_fee_minor = EXCLUDED.interstate_fee_minor,
         transit_days_min = EXCLUDED.transit_days_min, transit_days_max = EXCLUDED.transit_days_max, updated_at = now()`,
      [
        shop.id,
        input.scope,
        states,
        excluded,
        input.offersPickup,
        input.offersSellerArranged,
        input.offersIntegrated,
        input.sameCityFee,
        input.sameStateFee,
        input.interstateFee,
        input.transitDaysMin,
        input.transitDaysMax,
      ],
    );
    await tx.query(`UPDATE shops SET pickup_note = $2, updated_at = now() WHERE id = $1`, [shop.id, input.offersPickup ? input.pickupNote : null]);
    // Listing-level narrowing must stay inside the shop's coverage.
    const cov = {
      scope: input.scope,
      states,
      excludedStates: excluded,
      offersPickup: input.offersPickup,
      offersSellerArranged: input.offersSellerArranged,
      offersIntegrated: input.offersIntegrated,
      sameCityFeeMinor: input.sameCityFee,
      sameStateFeeMinor: input.sameStateFee,
      interstateFeeMinor: input.interstateFee,
      transitDaysMin: input.transitDaysMin,
      transitDaysMax: input.transitDaysMax,
    };
    const narrowed = await tx.query<{ id: string; delivery_states: string[] }>(
      `SELECT id, delivery_states FROM listings WHERE shop_id = $1 AND delivery_states IS NOT NULL AND cardinality(delivery_states) > 0 AND status <> 'removed'`,
      [shop.id],
    );
    for (const l of narrowed.rows) {
      const kept = l.delivery_states.filter((s) => shopCoversState(cov, shop.state, s, null));
      if (kept.length !== l.delivery_states.length) {
        await tx.query(`UPDATE listings SET delivery_states = $2, updated_at = now() WHERE id = $1`, [l.id, kept.length > 0 ? kept : null]);
      }
    }
  });
  return { shopId: shop.id };
}

/** Publishes a draft shop once the required onboarding steps are complete. */
export async function publishShop(ctx: AppContext): Promise<{ shopId: string; status: 'active' }> {
  requireVerifiedUser(ctx);
  const own = await requireOwnShop(ctx.pool, ctx);
  return withTransaction(ctx.pool, async (tx) => {
    const shop = await one<{ id: string; status: string }>(tx, `SELECT id, status FROM shops WHERE id = $1 FOR UPDATE`, [own.id]);
    if (shop.status === 'active') return { shopId: shop.id, status: 'active' as const };
    if (shop.status === 'paused') throw new DomainError('INVALID_STATE', 'Your shop is paused. Resume it instead.');
    if (shop.status === 'suspended') throw new DomainError('INVALID_STATE', 'This shop is suspended. Contact support.');
    const checklist = await computeChecklist(tx, shop.id);
    const missing = checklist.items.filter((i) => i.required && !i.done);
    if (missing.length > 0) {
      throw new DomainError('VALIDATION_FAILED', 'Finish the remaining setup steps before opening your shop.', {
        issues: missing.map((m) => ({ field: m.key, message: m.hint })),
      });
    }
    await tx.query(`UPDATE shops SET status = 'active', status_reason = NULL, published_at = coalesce(published_at, now()), updated_at = now() WHERE id = $1`, [shop.id]);
    await recordAudit(tx, ctx, { action: 'shop.published', targetKind: 'shop', targetId: shop.id });
    return { shopId: shop.id, status: 'active' as const };
  });
}

/** Paused shops stop new sales (listings leave discovery and buy actions are hidden); existing orders continue. */
export async function pauseShop(ctx: AppContext, raw: unknown = {}): Promise<{ shopId: string; status: 'paused' }> {
  requireUser(ctx);
  const input = parseInput(pauseShopInput, raw ?? {});
  const own = await requireOwnShop(ctx.pool, ctx);
  return withTransaction(ctx.pool, async (tx) => {
    const shop = await one<{ id: string; status: string }>(tx, `SELECT id, status FROM shops WHERE id = $1 FOR UPDATE`, [own.id]);
    if (shop.status === 'paused') return { shopId: shop.id, status: 'paused' as const };
    if (shop.status !== 'active') {
      throw new DomainError('INVALID_STATE', shop.status === 'draft' ? 'Your shop is not open yet, so there is nothing to pause.' : 'This shop is suspended. Contact support.');
    }
    await tx.query(`UPDATE shops SET status = 'paused', status_reason = $2, updated_at = now() WHERE id = $1`, [shop.id, input.note ?? 'Paused by the seller']);
    await recordAudit(tx, ctx, { action: 'shop.paused', targetKind: 'shop', targetId: shop.id, reason: input.note });
    return { shopId: shop.id, status: 'paused' as const };
  });
}

export async function resumeShop(ctx: AppContext): Promise<{ shopId: string; status: 'active' }> {
  requireUser(ctx);
  const own = await requireOwnShop(ctx.pool, ctx);
  return withTransaction(ctx.pool, async (tx) => {
    const shop = await one<{ id: string; status: string }>(tx, `SELECT id, status FROM shops WHERE id = $1 FOR UPDATE`, [own.id]);
    if (shop.status === 'active') return { shopId: shop.id, status: 'active' as const };
    if (shop.status !== 'paused') {
      throw new DomainError('INVALID_STATE', shop.status === 'draft' ? 'Open your shop from the setup checklist first.' : 'This shop is suspended. Contact support.');
    }
    await tx.query(`UPDATE shops SET status = 'active', status_reason = NULL, updated_at = now() WHERE id = $1`, [shop.id]);
    await recordAudit(tx, ctx, { action: 'shop.resumed', targetKind: 'shop', targetId: shop.id });
    return { shopId: shop.id, status: 'active' as const };
  });
}
