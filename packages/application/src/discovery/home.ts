import { locationPreferenceSchema } from '@thrift/contracts';
import type { CategoryKind } from '@thrift/domain';
import { many } from '@thrift/database';
import { LISTING_CARD_FROM, type ListingCardRow } from '../catalogue/cards';
import type { AppContext } from '../core/context';
import { DISCOVERY_CARD_COLUMNS, toDiscoveryCard, type DiscoveryCard } from './cards';
import { followedShopsNewItems } from './collections';
import { resolvePlaceInternal, type LocationPreference, type ResolvedPlace } from './location';
import { shopSummaryColumns, toShopSummary, NEG_REPUTATION_KEY_SQL, type ShopSummary, type ShopSummaryRow } from './shops';
import { interleaveSponsored, rotationOrderSql, sponsoredListingSql } from './sponsored';
import { pointSql, publicListingSql, PUBLISHED_AT_SQL, SqlParams } from './sql';

export interface CategoryShortcut {
  slug: string;
  name: string;
  kind: CategoryKind;
  listingCount: number;
}

export interface HomeFeed {
  location: LocationPreference | null;
  /** Signed-in only (null for guests): latest items from followed shops. */
  following: DiscoveryCard[] | null;
  /** Most recently published, with labelled sponsored items mixed in (never more than 2 in a row). */
  newDrops: DiscoveryCard[];
  liveAuctions: DiscoveryCard[];
  upcomingAuctions: DiscoveryCard[];
  /** Items from shops near the chosen location (null when no location is set). */
  nearYou: DiscoveryCard[] | null;
  categories: CategoryShortcut[];
  shops: ShopSummary[];
  serverNow: string;
}

const LIMITS = { following: 8, newDrops: 12, sponsored: 3, live: 8, upcoming: 4, nearYou: 8, shops: 6 };
const NEAR_YOU_KM = 50;

/**
 * Home feed sections. Each section is a small, indexed query run in parallel. Sponsored items come only from
 * active, in-window `home_feed` campaigns for still-available listings, and are always flagged.
 */
export async function getHomeFeed(ctx: AppContext, location: LocationPreference | null): Promise<HomeFeed> {
  const now = ctx.now();
  const loc = location ? locationPreferenceSchema.safeParse(location) : null;
  const chosen = loc?.success ? loc.data : null;
  const place = chosen ? await resolvePlaceInternal(ctx.pool, chosen.placeId) : null;

  const [following, organic, sponsored, live, upcoming, nearYou, categories, shops] = await Promise.all([
    ctx.actor.kind === 'user' ? followedShopsNewItems(ctx, { limit: LIMITS.following }).then((r) => r.items) : Promise.resolve(null),
    listCards(ctx, now, { order: `${PUBLISHED_AT_SQL} DESC, l.id DESC`, limit: LIMITS.newDrops }),
    sponsoredHome(ctx, now),
    listCards(ctx, now, {
      extra: (_p, nowParam) => [`l.sale_mode = 'auction'`, `a.status = 'live'`, `a.starts_at <= ${nowParam}`],
      order: `a.ends_at ASC, l.id ASC`,
      limit: LIMITS.live,
    }),
    listCards(ctx, now, {
      extra: () => [`l.sale_mode = 'auction'`, `a.status = 'scheduled'`],
      order: `a.starts_at ASC, l.id ASC`,
      limit: LIMITS.upcoming,
    }),
    place ? nearYouCards(ctx, now, place) : Promise.resolve(null),
    categoryShortcuts(ctx, now),
    shopsToDiscover(ctx, now, place),
  ]);

  return {
    location: chosen && place ? chosen : null,
    following,
    newDrops: interleaveSponsored(organic, sponsored, { firstSlot: 1, gap: 4, maxRun: 2, maxSponsored: LIMITS.sponsored }),
    liveAuctions: live,
    upcomingAuctions: upcoming,
    nearYou,
    categories,
    shops,
    serverNow: now.toISOString(),
  };
}

async function listCards(
  ctx: AppContext,
  now: Date,
  args: { extra?: (p: SqlParams, nowParam: string) => string[]; order: string; limit: number },
): Promise<DiscoveryCard[]> {
  const p = new SqlParams();
  const nowParam = p.add(now, 'timestamptz');
  const where = [publicListingSql(nowParam), ...(args.extra ? args.extra(p, nowParam) : [])];
  const rows = await many<ListingCardRow>(
    ctx.pool,
    `SELECT ${DISCOVERY_CARD_COLUMNS} FROM ${LISTING_CARD_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY ${args.order}
      LIMIT ${p.add(args.limit, 'int')}`,
    p.values,
  );
  return rows.map((r) => toDiscoveryCard(r));
}

async function sponsoredHome(ctx: AppContext, now: Date): Promise<DiscoveryCard[]> {
  const p = new SqlParams();
  const nowParam = p.add(now, 'timestamptz');
  const rows = await many<ListingCardRow>(
    ctx.pool,
    `SELECT ${DISCOVERY_CARD_COLUMNS} FROM ${LISTING_CARD_FROM}
      WHERE ${publicListingSql(nowParam)} AND ${sponsoredListingSql(p, 'home_feed', nowParam)}
      ORDER BY ${rotationOrderSql(p, 'l.id', now)}
      LIMIT ${LIMITS.sponsored}`,
    p.values,
  );
  return rows.map((r) => toDiscoveryCard(r, { sponsored: true }));
}

async function nearYouCards(ctx: AppContext, now: Date, place: ResolvedPlace): Promise<DiscoveryCard[]> {
  return listCards(ctx, now, {
    extra: (p) =>
      place.kind === 'state'
        ? [`s.state = ${p.add(place.state, 'text')}`]
        : [`s.location IS NOT NULL AND ST_DWithin(s.location, ${pointSql(p, place.point)}, ${p.add(NEAR_YOU_KM * 1000, 'float8')})`],
    order: `${PUBLISHED_AT_SQL} DESC, l.id DESC`,
    limit: LIMITS.nearYou,
  });
}

/** Top-level categories with counts of public listings in the category or any descendant. */
export async function categoryShortcuts(ctx: AppContext, now: Date = ctx.now()): Promise<CategoryShortcut[]> {
  const p = new SqlParams();
  const rows = await many<{ slug: string; name: string; kind: CategoryKind; listing_count: number }>(
    ctx.pool,
    `WITH RECURSIVE tree AS (
       SELECT id, id AS root_id FROM categories WHERE parent_id IS NULL AND active
       UNION ALL
       SELECT c.id, t.root_id FROM categories c JOIN tree t ON c.parent_id = t.id WHERE c.active
     ), counts AS (
       SELECT t.root_id, count(*)::int AS n
         FROM tree t
         JOIN listings l ON l.category_id = t.id
         JOIN shops s ON s.id = l.shop_id
         LEFT JOIN LATERAL (SELECT * FROM auctions ax WHERE ax.listing_id = l.id ORDER BY ax.created_at DESC LIMIT 1) a ON true
        WHERE ${publicListingSql(p.add(now, 'timestamptz'))}
        GROUP BY t.root_id
     )
     SELECT r.slug, r.name, r.kind, coalesce(counts.n, 0)::int AS listing_count
       FROM categories r LEFT JOIN counts ON counts.root_id = r.id
      WHERE r.parent_id IS NULL AND r.active
      ORDER BY r.sort_order, r.name`,
    p.values,
  );
  return rows.map((r) => ({ slug: r.slug, name: r.name, kind: r.kind, listingCount: r.listing_count }));
}

/** Verified or established shops with stock, nearest first when a location is known. */
async function shopsToDiscover(ctx: AppContext, now: Date, place: ResolvedPlace | null): Promise<ShopSummary[]> {
  const p = new SqlParams();
  const nowParam = p.add(now, 'timestamptz');
  const pt = place ? pointSql(p, place.point) : null;
  const rows = await many<ShopSummaryRow>(
    ctx.pool,
    `SELECT * FROM (
        SELECT ${shopSummaryColumns(nowParam)},
               ${pt ? `ST_Distance(s.location, ${pt})` : 'NULL::float8'} AS distance_m,
               ${pt ? `coalesce(floor(ST_Distance(s.location, ${pt}) / 5000)::bigint, 999999999)` : '0::bigint'} AS k1,
               ${NEG_REPUTATION_KEY_SQL} AS k2
          FROM shops s LEFT JOIN delivery_coverage dc ON dc.shop_id = s.id
         WHERE s.status = 'active'
           AND (s.verification_status = 'approved' OR s.reputation_tier IN ('established','trusted'))
      ) x
      WHERE x.active_count > 0
      ORDER BY x.k1, (x.verification_status = 'approved') DESC, x.k2, x.id
      LIMIT ${p.add(LIMITS.shops, 'int')}`,
    p.values,
  );
  return rows.map((r) => toShopSummary(r));
}
