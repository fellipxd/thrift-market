import { LISTING_PUBLIC_WHERE } from '../catalogue/cards';

/** Collects positional parameters while a query is composed ($1, $2, ...). Values are never interpolated. */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return `$${this.values.length}${cast ? `::${cast}` : ''}`;
  }
}

/**
 * Public discovery visibility for a listing row (aliases: l listings, s shops, a auctions LEFT JOIN):
 * published listings (active or reserved) of active shops; auction listings only while their auction is scheduled
 * or live and has not passed its end time. Drafts, paused, removed, sold and ended listings never match.
 */
export function publicListingSql(nowParam: string): string {
  return `(${LISTING_PUBLIC_WHERE} AND (l.sale_mode <> 'auction' OR (a.status IN ('scheduled','live') AND a.ends_at > ${nowParam})))`;
}

/** What a buyer would pay now: listed price, or the current bid / opening price for auctions. Integer kobo. */
export const EFFECTIVE_PRICE_SQL = `coalesce(CASE WHEN l.sale_mode = 'auction' THEN coalesce(a.current_bid_minor, a.opening_price_minor) ELSE l.price_minor END, 0)`;

/** Publication time used for "newest" ordering (matches the 0200 partial expression index). */
export const PUBLISHED_AT_SQL = `coalesce(l.published_at, l.created_at)`;

/** Exact (microsecond) UTC text form of a timestamp, so keyset cursors round-trip without JS Date truncation. */
export function timestampKeySql(expr: string): string {
  return `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export const TIMESTAMP_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Escapes LIKE wildcards in user text (used with ESCAPE '\'). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Geography point from internal coordinates (reference-place centroids or coarsened device coordinates). */
export function pointSql(p: SqlParams, point: { lat: number; lng: number }): string {
  return `ST_SetSRID(ST_MakePoint(${p.add(point.lng, 'float8')}, ${p.add(point.lat, 'float8')}), 4326)::geography`;
}

/**
 * Photo for a listing card, limited to ready public media. Mirrors the projection in catalogue/cards.ts.
 */
export function firstPhotoSql(listingAlias: string): string {
  return `(SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id
            WHERE lm.listing_id = ${listingAlias}.id AND m.status = 'ready' AND m.visibility = 'public'
            ORDER BY lm.position LIMIT 1)`;
}
