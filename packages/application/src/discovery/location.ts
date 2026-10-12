import { chooseLocationInput, deviceLocationInput, locationPreferenceSchema, placeSearchInput } from '@thrift/contracts';
import { coarsenCoordinate, DomainError, stateLabel, type NigerianState } from '@thrift/domain';
import { many, maybeOne, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { escapeLike, SqlParams, pointSql } from './sql';

/**
 * Buyer location choice. The chosen delivery location lives in the `tm_loc` cookie as
 * JSON {placeId, name, state, city}: a reference place only, never device coordinates.
 * Other slices (item page delivery estimate) read the same shape via parseLocationCookie().
 */
export const LOCATION_COOKIE = 'tm_loc';
export const LOCATION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/** Device coordinates further than this from every reference place are not matched (e.g. outside Nigeria). */
const MAX_DEVICE_MATCH_KM = 150;

export interface LocationPreference {
  placeId: string;
  /** Display name of the chosen place, e.g. "Yaba" or "Abuja" or "Kano" (state). */
  name: string;
  state: NigerianState;
  /** City used for same-city pickup checks; '' when only a state was chosen. */
  city: string;
}

export type PlaceKind = 'city' | 'area' | 'state';

/** A reference place as shown to buyers. Never includes coordinates. */
export interface PlaceOption {
  id: string;
  name: string;
  state: NigerianState;
  kind: PlaceKind;
  city: string;
  label: string;
}

/** Internal resolved place including its approximate public centroid. Never returned to clients. */
export interface ResolvedPlace extends PlaceOption {
  point: { lat: number; lng: number };
}

export function placeLabel(p: { name: string; state: string; kind: PlaceKind; city: string }): string {
  if (p.kind === 'state') return p.state === 'FCT' ? 'Abuja (FCT)' : `${p.state} State`;
  if (p.kind === 'area') return `${p.name}, ${p.city || stateLabel(p.state)}`;
  return p.state === 'FCT' || p.name === p.state ? p.name : `${p.name}, ${p.state}`;
}

/** Short label for the chosen location, e.g. "Abuja", "Yaba, Lagos", "Kano State". */
export function locationLabel(loc: LocationPreference): string {
  if (!loc.city) return loc.state === 'FCT' ? 'Abuja (FCT)' : `${loc.state} State`;
  if (loc.city !== loc.name) return `${loc.name}, ${loc.city}`;
  return loc.name;
}

export function toLocationPreference(p: PlaceOption): LocationPreference {
  return { placeId: p.id, name: p.name, state: p.state, city: p.city };
}

/** Parses the `tm_loc` cookie value (raw JSON or URI-encoded JSON). Invalid or tampered values → null. */
export function parseLocationCookie(raw: string | null | undefined): LocationPreference | null {
  if (!raw || raw.length > 600) return null;
  for (const candidate of [raw, safeDecode(raw)]) {
    if (!candidate) continue;
    try {
      const parsed = locationPreferenceSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // try the next form
    }
  }
  return null;
}

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function serializeLocationCookie(loc: LocationPreference): string {
  return JSON.stringify({ placeId: loc.placeId, name: loc.name, state: loc.state, city: loc.city });
}

interface PlaceRow {
  id: string;
  name: string;
  state: NigerianState;
  kind: PlaceKind;
  city: string;
  [k: string]: unknown;
}

/** City for a place: itself for cities, the state's main city for areas, '' for whole states. */
const PLACE_CITY_SQL = `CASE p.kind WHEN 'city' THEN p.name
    WHEN 'area' THEN coalesce((SELECT c.name FROM places c WHERE c.state = p.state AND c.kind = 'city' ORDER BY c.population_rank, c.name LIMIT 1), '')
    ELSE '' END`;

function toPlaceOption(r: PlaceRow): PlaceOption {
  const base = { id: r.id, name: r.name, state: r.state, kind: r.kind, city: r.city };
  return { ...base, label: placeLabel(base) };
}

/**
 * Location typeahead: top 8 reference places by exact/prefix match, trigram similarity, kind (city before area
 * before state) and size. Matching a state name also lists that state's places.
 */
export async function placeSearch(ctx: AppContext, raw: unknown): Promise<PlaceOption[]> {
  const { q } = parseInput(placeSearchInput, raw);
  return searchPlaces(ctx.pool, q, 8);
}

async function searchPlaces(db: Queryable, text: string, limit: number): Promise<PlaceOption[]> {
  const p = new SqlParams();
  const q = p.add(text.toLowerCase(), 'text');
  const prefix = p.add(`${escapeLike(text.toLowerCase())}%`, 'text');
  const wordPrefix = p.add(`% ${escapeLike(text.toLowerCase())}%`, 'text');
  const rows = await many<PlaceRow>(
    db,
    `SELECT p.id, p.name, p.state, p.kind, ${PLACE_CITY_SQL} AS city
       FROM places p
      WHERE lower(p.name) LIKE ${prefix} ESCAPE '\\'
         OR lower(p.name) LIKE ${wordPrefix} ESCAPE '\\'
         OR lower(p.name) % ${q}
         OR lower(p.state) = ${q}
      ORDER BY (lower(p.name) = ${q}) DESC,
               (lower(p.name) LIKE ${prefix} ESCAPE '\\') DESC,
               similarity(lower(p.name), ${q}) DESC,
               CASE p.kind WHEN 'city' THEN 0 WHEN 'area' THEN 1 ELSE 2 END,
               p.population_rank, p.name
      LIMIT ${p.add(limit, 'int')}`,
    p.values,
  );
  return rows.map(toPlaceOption);
}

/** Internal: a place with its centroid, for distance queries. */
export async function resolvePlaceInternal(db: Queryable, placeId: string): Promise<ResolvedPlace | null> {
  const r = await maybeOne<PlaceRow & { lat: number; lng: number }>(
    db,
    `SELECT p.id, p.name, p.state, p.kind, ${PLACE_CITY_SQL} AS city,
            ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng
       FROM places p WHERE p.id = $1::uuid`,
    [placeId],
  );
  if (!r) return null;
  return { ...toPlaceOption(r), point: { lat: Number(r.lat), lng: Number(r.lng) } };
}

/** Public: a place by id (no coordinates). */
export async function resolvePlace(ctx: AppContext, placeId: string): Promise<PlaceOption | null> {
  if (!/^[0-9a-f-]{36}$/i.test(placeId)) return null;
  const r = await resolvePlaceInternal(ctx.pool, placeId);
  return r ? stripPoint(r) : null;
}

function stripPoint(r: ResolvedPlace): PlaceOption {
  return { id: r.id, name: r.name, state: r.state, kind: r.kind, city: r.city, label: r.label };
}

/** Coarsens device coordinates to ~1 km before any use; precise values are never stored or logged. */
export function coarsenPoint(point: { lat: number; lng: number }): { lat: number; lng: number } {
  return { lat: coarsenCoordinate(point.lat, 2), lng: coarsenCoordinate(point.lng, 2) };
}

/** Nearest city/area reference place to a point, or null when nothing is within range. */
export async function nearestPlace(db: Queryable, point: { lat: number; lng: number }): Promise<PlaceOption | null> {
  const p = new SqlParams();
  const pt = pointSql(p, coarsenPoint(point));
  const r = await maybeOne<PlaceRow & { meters: number }>(
    db,
    `SELECT p.id, p.name, p.state, p.kind, ${PLACE_CITY_SQL} AS city, ST_Distance(p.location, ${pt}) AS meters
       FROM places p
      WHERE p.kind IN ('city','area')
      ORDER BY p.location <-> ${pt}
      LIMIT 1`,
    p.values,
  );
  if (!r || Number(r.meters) > MAX_DEVICE_MATCH_KM * 1000) return null;
  return toPlaceOption(r);
}

/**
 * "Use my location": resolves device coordinates to the nearest reference place. Only the place is returned
 * (and stored by the caller in the cookie); the coordinates are discarded after this request.
 */
export async function locationFromDevice(ctx: AppContext, raw: unknown): Promise<LocationPreference> {
  const point = parseInput(deviceLocationInput, raw);
  const place = await nearestPlace(ctx.pool, point);
  if (!place) {
    throw new DomainError('NOT_FOUND', "We couldn't match your location to a town we cover yet. Type your city or state instead.");
  }
  return toLocationPreference(place);
}

/** Typed location choice: a place id from the typeahead, or free text resolved to the best match. */
export async function chooseLocation(ctx: AppContext, raw: unknown): Promise<LocationPreference> {
  const input = parseInput(chooseLocationInput, raw);
  if (input.placeId) {
    const place = await resolvePlace(ctx, input.placeId);
    if (!place) {
      throw new DomainError('NOT_FOUND', 'That location is no longer available. Search again.', {
        fieldErrors: { where: 'That location is no longer available. Search again.' },
      });
    }
    return toLocationPreference(place);
  }
  const text = (input.where ?? '').replace(/\s+/g, ' ').trim();
  const [best] = await searchPlaces(ctx.pool, text, 1);
  if (!best) {
    const message = `We couldn't find “${text}”. Try a nearby city or your state.`;
    throw new DomainError('NOT_FOUND', message, { fieldErrors: { where: message } });
  }
  return toLocationPreference(best);
}
