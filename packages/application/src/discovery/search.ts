import { searchFiltersInput, type SearchFilters, type SearchSort } from '@thrift/contracts';
import { DomainError, type ConditionGrade, type SaleMode } from '@thrift/domain';
import { many, maybeOne, one, type Queryable } from '@thrift/database';
import { LISTING_CARD_FROM, type ListingCardRow } from '../catalogue/cards';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { DISCOVERY_CARD_COLUMNS, toDiscoveryCard, type DiscoveryCard } from './cards';
import { decodeCursor, encodeCursor, filterHash, type CursorKeyKind } from './cursor';
import { deliverableSql } from './deliverable';
import { coarsenPoint, resolvePlaceInternal } from './location';
import { rotationOrderSql, sponsoredListingSql } from './sponsored';
import { EFFECTIVE_PRICE_SQL, pointSql, publicListingSql, PUBLISHED_AT_SQL, SqlParams, timestampKeySql } from './sql';

export interface AppliedSearchFilters {
  q: string | null;
  category: { slug: string; name: string } | null;
  sizes: string[];
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  conditions: ConditionGrade[];
  saleModes: SaleMode[];
  shop: { slug: string; name: string } | null;
  deliverTo: { state: string; city: string | null } | null;
  near: { placeId: string | null; label: string } | null;
  radiusKm: number | null;
  verifiedOnly: boolean;
}

export interface SearchResult {
  items: DiscoveryCard[];
  /** Sponsored listings matching the same filters (first page only). Always labelled; never mixed into ranking. */
  sponsored: DiscoveryCard[];
  nextCursor: string | null;
  /** Result count on the first page, capped for cost ("1000+"). Null on later pages. */
  total: { count: number; capped: boolean } | null;
  /** Sort actually applied (relevance needs a query; nearest needs a location). */
  sort: SearchSort;
  filters: AppliedSearchFilters;
  serverNow: string;
}

const COUNT_CAP = 1000;

interface SortSpec {
  expr: string;
  kind: CursorKeyKind;
  dir: 'ASC' | 'DESC';
}

interface Prepared {
  filters: SearchFilters;
  applied: AppliedSearchFilters;
  sort: SearchSort;
  categoryIds: string[] | null;
  shopId: string | null;
  point: { lat: number; lng: number } | null;
}

/** Category and its descendants (any depth). */
async function categoryWithDescendants(db: Queryable, slug: string): Promise<{ name: string; ids: string[] } | null> {
  const cat = await maybeOne<{ id: string; name: string }>(db, `SELECT id, name FROM categories WHERE slug = $1 AND active`, [slug]);
  if (!cat) return null;
  const rows = await many<{ id: string }>(
    db,
    `WITH RECURSIVE sub AS (
       SELECT id FROM categories WHERE id = $1
       UNION ALL
       SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id WHERE c.active
     ) SELECT id FROM sub`,
    [cat.id],
  );
  return { name: cat.name, ids: rows.map((r) => r.id) };
}

function invalid(field: string, message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', message, { fieldErrors: { [field]: message } });
}

async function prepare(ctx: AppContext, raw: unknown): Promise<Prepared> {
  const filters = parseInput(searchFiltersInput, raw ?? {});
  let categoryIds: string[] | null = null;
  let category: AppliedSearchFilters['category'] = null;
  if (filters.category) {
    const c = await categoryWithDescendants(ctx.pool, filters.category);
    if (!c) throw invalid('category', 'That category does not exist.');
    categoryIds = c.ids;
    category = { slug: filters.category, name: c.name };
  }
  let shopId: string | null = null;
  let shop: AppliedSearchFilters['shop'] = null;
  if (filters.shop) {
    const s = await maybeOne<{ id: string; name: string }>(ctx.pool, `SELECT id, name FROM shops WHERE slug = $1 AND status = 'active'`, [filters.shop]);
    if (!s) throw invalid('shop', 'That shop is not selling right now.');
    shopId = s.id;
    shop = { slug: filters.shop, name: s.name };
  }
  let point: Prepared['point'] = null;
  let near: AppliedSearchFilters['near'] = null;
  if (filters.near) {
    const place = await resolvePlaceInternal(ctx.pool, filters.near);
    if (!place) throw invalid('near', 'That location is no longer available. Choose it again.');
    point = place.point;
    near = { placeId: place.id, label: place.label };
  } else if (filters.point) {
    point = coarsenPoint(filters.point);
    near = { placeId: null, label: 'your location' };
  }
  let sort: SearchSort = filters.sort ?? (filters.q ? 'relevance' : 'newest');
  if (sort === 'relevance' && !filters.q) sort = 'newest';
  if (sort === 'nearest' && !point) sort = 'newest';
  const applied: AppliedSearchFilters = {
    q: filters.q ?? null,
    category,
    sizes: filters.sizes,
    minPriceMinor: filters.minPriceMinor ?? null,
    maxPriceMinor: filters.maxPriceMinor ?? null,
    conditions: filters.conditions,
    saleModes: sort === 'ending_soon' ? ['auction'] : filters.saleModes,
    shop,
    deliverTo: filters.deliverTo ? { state: filters.deliverTo.state, city: filters.deliverTo.city || null } : null,
    near,
    radiusKm: point ? filters.radiusKm : null,
    verifiedOnly: filters.verifiedOnly,
  };
  return { filters, applied, sort, categoryIds, shopId, point };
}

/** WHERE conditions for the applied filters (aliases from LISTING_CARD_FROM plus dc delivery_coverage). */
function buildWhere(ctx: AppContext, p: SqlParams, prep: Prepared, nowParam: string): string[] {
  const { applied, point } = prep;
  const where = [publicListingSql(nowParam)];
  if (applied.q) {
    const q = p.add(applied.q, 'text');
    where.push(`(l.search_vector @@ websearch_to_tsquery('simple', ${q}) OR lower(${q}) <% lower(l.title))`);
  }
  if (prep.categoryIds) where.push(`l.category_id = ANY(${p.add(prep.categoryIds, 'uuid[]')})`);
  if (applied.sizes.length) where.push(`lower(l.size_label) = ANY(${p.add(applied.sizes.map((s) => s.toLowerCase()), 'text[]')})`);
  if (applied.minPriceMinor !== null) where.push(`${EFFECTIVE_PRICE_SQL} >= ${p.add(applied.minPriceMinor, 'bigint')}`);
  if (applied.maxPriceMinor !== null) where.push(`${EFFECTIVE_PRICE_SQL} <= ${p.add(applied.maxPriceMinor, 'bigint')}`);
  if (applied.conditions.length) where.push(`l.condition = ANY(${p.add(applied.conditions, 'text[]')})`);
  if (applied.saleModes.length) where.push(`l.sale_mode = ANY(${p.add(applied.saleModes, 'text[]')})`);
  if (prep.shopId) where.push(`s.id = ${p.add(prep.shopId, 'uuid')}`);
  if (applied.verifiedOnly) where.push(`s.verification_status = 'approved'`);
  if (applied.deliverTo) {
    where.push(
      deliverableSql(p, {
        state: applied.deliverTo.state,
        city: applied.deliverTo.city,
        courierProvider: ctx.providers.courier.name,
        listingScoped: true,
      }),
    );
  }
  if (point && applied.radiusKm !== null) {
    where.push(`(s.location IS NOT NULL AND ST_DWithin(s.location, ${pointSql(p, point)}, ${p.add(applied.radiusKm * 1000, 'float8')}))`);
  }
  return where;
}

function sortSpec(p: SqlParams, prep: Prepared): SortSpec {
  switch (prep.sort) {
    case 'relevance': {
      const q = p.add(prep.applied.q ?? '', 'text');
      return {
        expr: `round((ts_rank_cd(l.search_vector, websearch_to_tsquery('simple', ${q})) * 2 + word_similarity(lower(${q}), lower(l.title))) * 10000)::bigint`,
        kind: 'int',
        dir: 'DESC',
      };
    }
    case 'price_asc':
      return { expr: EFFECTIVE_PRICE_SQL, kind: 'int', dir: 'ASC' };
    case 'price_desc':
      return { expr: EFFECTIVE_PRICE_SQL, kind: 'int', dir: 'DESC' };
    case 'ending_soon':
      return { expr: 'a.ends_at', kind: 'ts', dir: 'ASC' };
    case 'nearest':
      // 250 m buckets: ordering stays meaningful while cursors never carry a precise distance.
      return { expr: `coalesce(round(ST_Distance(s.location, ${pointSql(p, prep.point!)}) / 250)::bigint, 999999999)`, kind: 'int', dir: 'ASC' };
    case 'newest':
    default:
      return { expr: PUBLISHED_AT_SQL, kind: 'ts', dir: 'DESC' };
  }
}

const FROM_SQL = `${LISTING_CARD_FROM}
  LEFT JOIN delivery_coverage dc ON dc.shop_id = s.id`;

type Row = ListingCardRow & { sort_key: string | number };

/**
 * Browse and search (R07). Public listings only; filters for text, category (with descendants), size, price,
 * condition, sale mode, shop, deliverable destination, location radius and verified sellers. Stable keyset
 * pagination by (sort key, id). Reserved listings appear flagged by status; ended auctions never appear.
 */
function buildMainQuery(ctx: AppContext, prep: Prepared, now: Date, hash: string): { sql: string; values: unknown[] } {
  const p = new SqlParams();
  const nowParam = p.add(now, 'timestamptz');
  const where = buildWhere(ctx, p, prep, nowParam);
  const spec = sortSpec(p, prep);
  if (prep.filters.cursor) {
    const c = decodeCursor(prep.filters.cursor, { sort: prep.sort, filters: hash, kinds: [spec.kind] });
    const key = p.add(c.keys[0], spec.kind === 'ts' ? 'timestamptz' : 'bigint');
    where.push(`(${spec.expr}, l.id) ${spec.dir === 'DESC' ? '<' : '>'} (${key}, ${p.add(c.id, 'uuid')})`);
  }
  const keySelect = spec.kind === 'ts' ? timestampKeySql(spec.expr) : spec.expr;
  const sql = `SELECT ${DISCOVERY_CARD_COLUMNS}, ${keySelect} AS sort_key
      FROM ${FROM_SQL}
     WHERE ${where.join('\n       AND ')}
     ORDER BY ${spec.expr} ${spec.dir}, l.id ${spec.dir}
     LIMIT ${p.add(prep.filters.limit + 1, 'int')}`;
  return { sql, values: p.values };
}

/** The exact main search statement for given filters (used by the performance test to EXPLAIN it). */
export async function searchQueryForExplain(ctx: AppContext, raw: unknown): Promise<{ sql: string; values: unknown[] }> {
  const prep = await prepare(ctx, raw);
  const now = ctx.now();
  return buildMainQuery(ctx, prep, now, filterHash({ ...prep.applied, sort: prep.sort }));
}

export async function searchListings(ctx: AppContext, raw: unknown): Promise<SearchResult> {
  const prep = await prepare(ctx, raw);
  const now = ctx.now();
  const hash = filterHash({ ...prep.applied, sort: prep.sort });
  const limit = prep.filters.limit;
  const main = buildMainQuery(ctx, prep, now, hash);

  const firstPage = !prep.filters.cursor;
  const [rows, total, sponsored] = await Promise.all([
    many<Row>(ctx.pool, main.sql, main.values),
    firstPage ? countResults(ctx, prep, now) : Promise.resolve(null),
    firstPage ? sponsoredForSearch(ctx, prep, now) : Promise.resolve([]),
  ]);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ sort: prep.sort, filters: hash, keys: [last.sort_key], id: last.id }) : null;
  return {
    items: page.map((r) => toDiscoveryCard(r)),
    sponsored,
    nextCursor,
    total,
    sort: prep.sort,
    filters: prep.applied,
    serverNow: now.toISOString(),
  };
}

async function countResults(ctx: AppContext, prep: Prepared, now: Date): Promise<{ count: number; capped: boolean }> {
  const p = new SqlParams();
  const where = buildWhere(ctx, p, prep, p.add(now, 'timestamptz'));
  const r = await one<{ n: number }>(
    ctx.pool,
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${FROM_SQL} WHERE ${where.join(' AND ')} LIMIT ${COUNT_CAP + 1}) x`,
    p.values,
  );
  return { count: Math.min(r.n, COUNT_CAP), capped: r.n > COUNT_CAP };
}

async function sponsoredForSearch(ctx: AppContext, prep: Prepared, now: Date): Promise<DiscoveryCard[]> {
  const p = new SqlParams();
  const nowParam = p.add(now, 'timestamptz');
  const where = buildWhere(ctx, p, prep, nowParam);
  where.push(sponsoredListingSql(p, 'search_results', nowParam));
  const rows = await many<ListingCardRow>(
    ctx.pool,
    `SELECT ${DISCOVERY_CARD_COLUMNS} FROM ${FROM_SQL} WHERE ${where.join(' AND ')}
      ORDER BY ${rotationOrderSql(p, 'l.id', now)} LIMIT 2`,
    p.values,
  );
  return rows.map((r) => toDiscoveryCard(r, { sponsored: true }));
}

export interface DiscoveryCategoryNode {
  slug: string;
  name: string;
  children: { slug: string; name: string }[];
}

/** Active category tree (two levels at launch) for filter controls. */
export async function discoveryCategories(ctx: AppContext): Promise<DiscoveryCategoryNode[]> {
  const rows = await many<{ id: string; slug: string; name: string; parent_id: string | null }>(
    ctx.pool,
    `SELECT id, slug, name, parent_id FROM categories WHERE active ORDER BY sort_order, name`,
  );
  const tops = rows.filter((r) => !r.parent_id);
  return tops.map((t) => ({
    slug: t.slug,
    name: t.name,
    children: rows.filter((r) => r.parent_id === t.id).map((c) => ({ slug: c.slug, name: c.name })),
  }));
}

/** Most common size labels among public listings (optionally within a category) for the size filter. */
export async function sizeFacets(ctx: AppContext, args: { category?: string | null } = {}): Promise<{ label: string; count: number }[]> {
  const p = new SqlParams();
  const where = [publicListingSql(p.add(ctx.now(), 'timestamptz')), `l.size_label IS NOT NULL`, `btrim(l.size_label) <> ''`];
  if (args.category) {
    const c = await categoryWithDescendants(ctx.pool, args.category);
    if (!c) return [];
    where.push(`l.category_id = ANY(${p.add(c.ids, 'uuid[]')})`);
  }
  const rows = await many<{ label: string; n: number }>(
    ctx.pool,
    `SELECT min(l.size_label) AS label, count(*)::int AS n
       FROM listings l JOIN shops s ON s.id = l.shop_id LEFT JOIN auctions a ON a.listing_id = l.id
      WHERE ${where.join(' AND ')}
      GROUP BY lower(l.size_label)
      ORDER BY n DESC, label
      LIMIT 30`,
    p.values,
  );
  return rows.map((r) => ({ label: r.label, count: r.n }));
}
