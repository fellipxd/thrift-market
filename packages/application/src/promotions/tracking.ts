import { createHash } from 'node:crypto';
import { many, maybeOne, type Queryable } from '@thrift/database';
import type { CampaignRow } from './shared';

/** Crawlers, link previewers and headless clients never count as impressions or clicks. */
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python-requests|httpclient/i;

export function isLikelyBot(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_UA.test(userAgent);
}

export interface PromotionViewer {
  /** `u:<userId>` for signed-in shoppers, otherwise derived from IP + user agent (hashed before storage). */
  viewerKey: string;
  userId: string | null;
  userAgent: string | null;
  secret: string;
}

function viewerHash(v: PromotionViewer): string {
  return createHash('sha256').update(`${v.secret}:ad:${v.viewerKey}`).digest('hex').slice(0, 32);
}

const LIVE_SQL = `c.status = 'active' AND c.starts_at <= now() AND c.ends_at > now()`;

/** Members of the promoting shop browsing their own placements don't count. */
async function excludeOwnShop<T extends { shop_id: string }>(db: Queryable, rows: T[], userId: string | null): Promise<T[]> {
  if (!userId || rows.length === 0) return rows;
  const mine = await many<{ shop_id: string }>(db, 'SELECT shop_id FROM shop_members WHERE user_id = $1', [userId]);
  const own = new Set(mine.map((m) => m.shop_id));
  return rows.filter((r) => !own.has(r.shop_id));
}

/**
 * Counts one impression per viewer per campaign per day for the sponsored entries a page actually showed.
 * Best effort: callers ignore failures so discovery never breaks because of reporting.
 */
export async function recordPromotionImpressions(
  db: Queryable,
  args: { placement: CampaignRow['placement']; targetIds: string[]; viewer: PromotionViewer },
): Promise<number> {
  const ids = [...new Set(args.targetIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 20);
  if (ids.length === 0 || isLikelyBot(args.viewer.userAgent)) return 0;
  const targetCol = args.placement === 'nearby' ? 'c.shop_id' : 'c.listing_id';
  const kind = args.placement === 'nearby' ? 'shop' : 'listing';
  const campaigns = await excludeOwnShop(
    db,
    await many<{ id: string; shop_id: string }>(
      db,
      `SELECT c.id, c.shop_id FROM ad_campaigns c WHERE c.placement = $1 AND c.target_kind = $2 AND ${targetCol} = ANY($3::uuid[]) AND ${LIVE_SQL}`,
      [args.placement, kind, ids],
    ),
    args.viewer.userId,
  );
  const hash = viewerHash(args.viewer);
  let counted = 0;
  for (const c of campaigns) {
    const fresh = await db.query(`INSERT INTO ad_impression_dedupe (campaign_id, viewer_hash, day) VALUES ($1, $2, current_date) ON CONFLICT DO NOTHING`, [c.id, hash]);
    if (!fresh.rowCount) continue;
    await db.query(
      `INSERT INTO ad_daily_stats (campaign_id, day, impressions) VALUES ($1, current_date, 1)
       ON CONFLICT (campaign_id, day) DO UPDATE SET impressions = ad_daily_stats.impressions + 1`,
      [c.id],
    );
    counted++;
  }
  return counted;
}

/**
 * A shopper followed a sponsored entry. Records at most one click per viewer per campaign per day (with the
 * signed-in shopper, for the informational attribution window) and returns where to send them — always the
 * promoted item or shop page, never a caller-supplied URL. Null when the target doesn't exist.
 */
export async function recordPromotionClick(
  db: Queryable,
  args: { placement: CampaignRow['placement']; targetId: string; viewer: PromotionViewer },
): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(args.targetId)) return null;
  let href: string | null;
  if (args.placement === 'nearby') {
    const shop = await maybeOne<{ slug: string }>(db, 'SELECT slug FROM shops WHERE id = $1', [args.targetId]);
    href = shop ? `/shops/${shop.slug}` : null;
  } else {
    const l = await maybeOne<{ id: string }>(db, 'SELECT id FROM listings WHERE id = $1', [args.targetId]);
    href = l ? `/items/${l.id}` : null;
  }
  if (!href || isLikelyBot(args.viewer.userAgent)) return href;
  const targetCol = args.placement === 'nearby' ? 'c.shop_id' : 'c.listing_id';
  const live = await excludeOwnShop(
    db,
    await many<{ id: string; shop_id: string }>(
      db,
      `SELECT c.id, c.shop_id FROM ad_campaigns c WHERE c.placement = $1 AND c.target_kind = $2 AND ${targetCol} = $3 AND ${LIVE_SQL} LIMIT 1`,
      [args.placement, args.placement === 'nearby' ? 'shop' : 'listing', args.targetId],
    ),
    args.viewer.userId,
  );
  const c = live[0];
  if (!c) return href;
  const fresh = await db.query(
    `INSERT INTO ad_clicks (campaign_id, user_id, viewer_hash, day) VALUES ($1, $2, $3, current_date) ON CONFLICT (campaign_id, viewer_hash, day) DO NOTHING`,
    [c.id, args.viewer.userId, viewerHash(args.viewer)],
  );
  if (fresh.rowCount) {
    await db.query(
      `INSERT INTO ad_daily_stats (campaign_id, day, clicks) VALUES ($1, current_date, 1)
       ON CONFLICT (campaign_id, day) DO UPDATE SET clicks = ad_daily_stats.clicks + 1`,
      [c.id],
    );
  }
  return href;
}
