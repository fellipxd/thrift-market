import { nearbyFiltersInput } from '@thrift/contracts';
import { DomainError } from '@thrift/domain';
import { many } from '@thrift/database';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { decodeCursor, encodeCursor, filterHash } from './cursor';
import { deliverableSql } from './deliverable';
import { coarsenPoint, nearestPlace, resolvePlaceInternal, type PlaceKind } from './location';
import { NEG_REPUTATION_KEY_SQL, shopSummaryColumns, toShopSummary, type ShopSummary, type ShopSummaryRow } from './shops';
import { rotationOrderSql, sponsoredShopSql } from './sponsored';
import { pointSql, SqlParams } from './sql';

export interface NearbyLocation {
  placeId: string | null;
  label: string;
  state: string;
  city: string;
  kind: PlaceKind | 'device';
}

export interface NearbyResult {
  /** The location searched around (a reference place; device searches report the nearest place). */
  location: NearbyLocation | null;
  radiusKm: number | null;
  shops: ShopSummary[];
  /** Shops with an active "nearby" spotlight that match the same filters (first page only), labelled Sponsored. */
  sponsored: ShopSummary[];
  nextCursor: string | null;
  filters: { verifiedOnly: boolean; minRating: number | null; deliversToMe: boolean };
}

type Row = ShopSummaryRow & { k1: number; k2: number };

/**
 * Nearby sellers (R08): around a typed place or (coarsened) device coordinates, within a radius, sorted by
 * approximate distance then reputation. Filters: verified only, minimum rating, delivers to the buyer's location.
 * Results carry an approximate distance label only — never coordinates or raw distances. Without a location the
 * list falls back to active shops nationwide ordered by reputation.
 */
export async function nearbyShops(ctx: AppContext, raw: unknown): Promise<NearbyResult> {
  const input = parseInput(nearbyFiltersInput, raw ?? {});
  const now = ctx.now();

  let point: { lat: number; lng: number } | null = null;
  let location: NearbyLocation | null = null;
  if (input.place) {
    const place = await resolvePlaceInternal(ctx.pool, input.place);
    if (!place) {
      throw new DomainError('VALIDATION_FAILED', 'That location is no longer available. Choose it again.', {
        fieldErrors: { place: 'That location is no longer available. Choose it again.' },
      });
    }
    point = place.point;
    location = { placeId: place.id, label: place.label, state: place.state, city: place.city, kind: place.kind };
  } else if (input.point) {
    point = coarsenPoint(input.point);
    const near = await nearestPlace(ctx.pool, point);
    location = near
      ? { placeId: near.id, label: `near ${near.label}`, state: near.state, city: near.city, kind: 'device' }
      : null;
    if (!near) {
      throw new DomainError('NOT_FOUND', "We couldn't match your location to a town we cover yet. Type your city or state instead.");
    }
  }
  if (input.deliversToMe && !location) {
    throw new DomainError('VALIDATION_FAILED', 'Choose your location to see shops that deliver to you.', {
      fieldErrors: { delivers: 'Choose your location to see shops that deliver to you.' },
    });
  }
  const radiusKm = point ? input.radiusKm : null;
  const filters = { verifiedOnly: input.verifiedOnly, minRating: input.minRating ?? null, deliversToMe: input.deliversToMe };
  const hash = filterHash({ place: location?.placeId ?? null, point: input.place ? null : point, radiusKm, ...filters });

  const build = (p: SqlParams, opts: { sponsoredOnly: boolean }) => {
    const nowParam = p.add(now, 'timestamptz');
    const pt = point ? pointSql(p, point) : null;
    const where = [`s.status = 'active'`];
    if (pt && radiusKm !== null) where.push(`s.location IS NOT NULL AND ST_DWithin(s.location, ${pt}, ${p.add(radiusKm * 1000, 'float8')})`);
    if (filters.verifiedOnly) where.push(`s.verification_status = 'approved'`);
    if (filters.minRating !== null) where.push(`s.review_count > 0 AND s.rating_avg >= ${p.add(filters.minRating, 'numeric')}`);
    const delivers = location
      ? deliverableSql(p, { state: location.state, city: location.city || null, courierProvider: ctx.providers.courier.name, listingScoped: false })
      : null;
    if (filters.deliversToMe && delivers) where.push(delivers);
    if (opts.sponsoredOnly) where.push(sponsoredShopSql(p, nowParam));
    const select = `${shopSummaryColumns(nowParam)},
        ${pt ? `ST_Distance(s.location, ${pt})` : 'NULL::float8'} AS distance_m,
        ${pt ? `coalesce(floor(ST_Distance(s.location, ${pt}) / 1000)::bigint, 999999999)` : '0::bigint'} AS k1,
        ${NEG_REPUTATION_KEY_SQL} AS k2,
        ${delivers ?? 'NULL::boolean'} AS delivers_to_you`;
    return { select, where };
  };

  const p = new SqlParams();
  const { select, where } = build(p, { sponsoredOnly: false });
  let keyset = '';
  if (input.cursor) {
    const c = decodeCursor(input.cursor, { sort: 'nearby', filters: hash, kinds: ['int', 'int'] });
    keyset = `WHERE (x.k1, x.k2, x.id) > (${p.add(c.keys[0], 'bigint')}, ${p.add(c.keys[1], 'bigint')}, ${p.add(c.id, 'uuid')})`;
  }
  const mainSql = `SELECT * FROM (
        SELECT ${select} FROM shops s LEFT JOIN delivery_coverage dc ON dc.shop_id = s.id
         WHERE ${where.join(' AND ')}
      ) x ${keyset}
      ORDER BY x.k1, x.k2, x.id
      LIMIT ${p.add(input.limit + 1, 'int')}`;

  const sponsoredQuery = async (): Promise<ShopSummary[]> => {
    const sp = new SqlParams();
    const built = build(sp, { sponsoredOnly: true });
    const rows = await many<Row>(
      ctx.pool,
      `SELECT ${built.select} FROM shops s LEFT JOIN delivery_coverage dc ON dc.shop_id = s.id
        WHERE ${built.where.join(' AND ')}
        ORDER BY ${rotationOrderSql(sp, 's.id', now)} LIMIT 2`,
      sp.values,
    );
    return rows.filter((r) => r.active_count > 0).map((r) => toShopSummary(r, { sponsored: true }));
  };

  const [rows, sponsored] = await Promise.all([many<Row>(ctx.pool, mainSql, p.values), input.cursor ? Promise.resolve([]) : sponsoredQuery()]);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    location,
    radiusKm,
    shops: page.map((r) => toShopSummary(r)),
    sponsored,
    nextCursor: rows.length > input.limit && last ? encodeCursor({ sort: 'nearby', filters: hash, keys: [Number(last.k1), Number(last.k2)], id: last.id }) : null,
    filters,
  };
}
