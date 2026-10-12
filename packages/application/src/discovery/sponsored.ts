import type { SqlParams } from './sql';

/**
 * Read side of paid promotion (R22). Campaigns are managed by the promotions slice; discovery only renders
 * placements that are active right now, for items/shops that are still public and available. Sponsored entries are
 * always flagged (`sponsored: true`) so the UI labels them, and they never alter verification or reputation fields.
 */
export type ListingPlacement = 'home_feed' | 'search_results';

/**
 * Listing has an active, in-window campaign for this placement and is still available to buy
 * (active with recorded stock; reserved/sold items leave promotion). Use together with publicListingSql.
 */
export function sponsoredListingSql(p: SqlParams, placement: ListingPlacement, nowParam: string): string {
  return `(l.status = 'active' AND coalesce(st.quantity_available, 0) > 0 AND EXISTS (
      SELECT 1 FROM ad_campaigns ac
       WHERE ac.listing_id = l.id AND ac.shop_id = l.shop_id AND ac.target_kind = 'listing'
         AND ac.placement = ${p.add(placement, 'text')} AND ac.status = 'active'
         AND ac.starts_at IS NOT NULL AND ac.ends_at IS NOT NULL
         AND ac.starts_at <= ${nowParam} AND ac.ends_at > ${nowParam}))`;
}

/** Shop has an active, in-window "nearby" spotlight campaign. */
export function sponsoredShopSql(p: SqlParams, nowParam: string): string {
  return `EXISTS (
      SELECT 1 FROM ad_campaigns ac
       WHERE ac.shop_id = s.id AND ac.target_kind = 'shop' AND ac.placement = 'nearby' AND ac.status = 'active'
         AND ac.starts_at IS NOT NULL AND ac.ends_at IS NOT NULL
         AND ac.starts_at <= ${nowParam} AND ac.ends_at > ${nowParam})`;
}

/** Fair hourly rotation among eligible sponsored entries (deterministic within the hour). */
export function rotationOrderSql(p: SqlParams, idExpr: string, now: Date): string {
  const seed = now.toISOString().slice(0, 13);
  return `md5(${idExpr}::text || ${p.add(seed, 'text')})`;
}

/**
 * Mixes sponsored entries into an organic list: first sponsored entry at `firstSlot`, then one after every
 * `gap` organic entries. Sponsored entries already present organically are dropped (the organic one stays in
 * place). Never more than `maxRun` sponsored entries in a row, even when organic entries run out.
 */
export function interleaveSponsored<T extends { id: string }>(
  organic: T[],
  sponsored: T[],
  opts: { firstSlot?: number; gap?: number; maxRun?: number; maxSponsored?: number } = {},
): (T & { sponsored?: boolean })[] {
  const firstSlot = Math.max(0, opts.firstSlot ?? 1);
  const gap = Math.max(1, opts.gap ?? 4);
  const maxRun = Math.max(1, opts.maxRun ?? 2);
  const maxSponsored = opts.maxSponsored ?? 4;
  const organicIds = new Set(organic.map((o) => o.id));
  const seen = new Set<string>();
  const queue = sponsored
    .filter((s) => !organicIds.has(s.id) && !seen.has(s.id) && (seen.add(s.id), true))
    .slice(0, maxSponsored)
    .map((s) => ({ ...s, sponsored: true as const }));
  const out: (T & { sponsored?: boolean })[] = [];
  let run = 0;
  let organicSinceAd = 0;
  let placedAny = false;
  let oi = 0;
  const pushSponsored = (): boolean => {
    if (queue.length === 0 || run >= maxRun) return false;
    out.push(queue.shift()!);
    run++;
    organicSinceAd = 0;
    placedAny = true;
    return true;
  };
  while (oi < organic.length) {
    const due = placedAny ? organicSinceAd >= gap : out.length >= firstSlot;
    if (due && pushSponsored()) continue;
    out.push(organic[oi++]!);
    run = 0;
    organicSinceAd++;
  }
  while (pushSponsored()) {
    // trailing sponsored entries, capped by maxRun
  }
  return out;
}
