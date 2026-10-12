import { z } from 'zod';
import { CONDITION_GRADES, NIGERIAN_STATES, SALE_MODES } from '@thrift/domain';
import { nairaInput } from './common';

/**
 * Discovery inputs (search, nearby shops, location choice). These usually arrive as URL query strings, so every
 * field tolerates strings, repeated keys (arrays) and empty values. The URL is the source of truth for filters.
 */

export const SEARCH_SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'ending_soon', 'nearest'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const SEARCH_SORT_LABEL: Record<SearchSort, string> = {
  relevance: 'Best match',
  newest: 'Newest first',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  ending_soon: 'Auctions ending soonest',
  nearest: 'Nearest first',
};

/** Radius options (km) for location-based discovery. `national` = no distance limit. */
export const RADIUS_OPTIONS = ['5', '10', '25', '50', '100', 'national'] as const;
export type RadiusOption = (typeof RADIUS_OPTIONS)[number];

export const MIN_RATING_OPTIONS = ['3', '3.5', '4', '4.5'] as const;

export const SEARCH_PAGE_DEFAULT = 24;
export const SEARCH_PAGE_MAX = 48;

/** First value of a possibly repeated query key; '' → undefined. */
function first(v: unknown): unknown {
  const x = Array.isArray(v) ? v[0] : v;
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'string' && x.trim() === '') return undefined;
  return x;
}

function single<T extends z.ZodType>(schema: T) {
  return z.preprocess(first, schema.optional());
}

/** Repeated keys or comma-separated values → de-duplicated array. */
function multi<T extends z.ZodType>(item: T, max: number, tooMany: string) {
  return z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === '') return [];
      const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
      return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
    },
    z.array(item).max(max, tooMany),
  );
}

/** Checkbox-style flag: "1", "true", "on", "yes" → true. */
export const flagInput = z.preprocess((v) => {
  const x = Array.isArray(v) ? v[v.length - 1] : v;
  return x === true || x === 'true' || x === '1' || x === 'on' || x === 'yes';
}, z.boolean());

const slug = (message: string) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,59}$/, message);

const cursorToken = z
  .string()
  .max(600, 'This results page link is out of date. Start again from the first page.')
  .regex(/^[A-Za-z0-9_-]+$/, 'This results page link is out of date. Start again from the first page.');

const latitude = z.coerce.number({ message: 'Location could not be read.' }).min(-90, 'Location could not be read.').max(90, 'Location could not be read.');
const longitude = z.coerce.number({ message: 'Location could not be read.' }).min(-180, 'Location could not be read.').max(180, 'Location could not be read.');

/** Free-text query: collapse whitespace and drop control characters. */
const queryText = z
  .string()
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
  .pipe(z.string().max(100, 'Keep your search under 100 characters.'));

const optionalNaira = single(nairaInput.pipe(z.number().int().min(0).max(100_000_000_000, 'That amount is too large.')));

const radiusInput = z
  .preprocess((v) => {
    const x = first(v);
    return x === undefined ? undefined : String(x);
  }, z.enum(RADIUS_OPTIONS, { message: 'Choose a distance from the list.' }).optional())
  .transform((r) => (r === undefined ? undefined : r === 'national' ? null : Number(r)));

export const searchFiltersInput = z
  .object({
    q: single(queryText),
    category: single(slug('That category does not exist.')),
    size: multi(z.string().trim().max(24, 'Size labels are short, e.g. M or 42.'), 12, 'Choose up to 12 sizes.'),
    minPrice: optionalNaira,
    maxPrice: optionalNaira,
    condition: multi(z.enum(CONDITION_GRADES, { message: 'Choose a condition from the list.' }), CONDITION_GRADES.length, 'Too many conditions.'),
    saleMode: multi(z.enum(SALE_MODES, { message: 'Choose a sale type from the list.' }), SALE_MODES.length, 'Too many sale types.'),
    shop: single(slug('That shop does not exist.')),
    deliverTo: single(z.enum(NIGERIAN_STATES, { message: 'Choose a Nigerian state.' })),
    city: single(z.string().trim().max(80)),
    near: single(z.string().uuid('Choose a location from the list.')),
    lat: single(latitude),
    lng: single(longitude),
    radius: radiusInput,
    verified: flagInput.optional(),
    sort: single(z.enum(SEARCH_SORTS, { message: 'Choose a sort order from the list.' })),
    cursor: single(cursorToken),
    limit: z.preprocess(first, z.coerce.number().int().min(1).max(SEARCH_PAGE_MAX).default(SEARCH_PAGE_DEFAULT)),
  })
  .superRefine((v, ctx) => {
    if (v.minPrice !== undefined && v.maxPrice !== undefined && v.minPrice > v.maxPrice) {
      ctx.addIssue({ code: 'custom', path: ['maxPrice'], message: 'Maximum price must be at least the minimum price.' });
    }
    if ((v.lat === undefined) !== (v.lng === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['lat'], message: 'Location could not be read.' });
    }
  })
  .transform((v) => ({
    q: v.q ? v.q : undefined,
    category: v.category,
    sizes: v.size,
    minPriceMinor: v.minPrice,
    maxPriceMinor: v.maxPrice,
    conditions: v.condition,
    saleModes: v.saleMode,
    shop: v.shop,
    deliverTo: v.deliverTo ? { state: v.deliverTo, city: v.city ?? null } : undefined,
    near: v.near,
    point: v.lat !== undefined && v.lng !== undefined ? { lat: v.lat, lng: v.lng } : undefined,
    radiusKm: v.radius ?? null,
    verifiedOnly: v.verified ?? false,
    sort: v.sort,
    cursor: v.cursor,
    limit: v.limit,
  }));
export type SearchFiltersInput = z.input<typeof searchFiltersInput>;
export type SearchFilters = z.output<typeof searchFiltersInput>;

export const nearbyFiltersInput = z
  .object({
    place: single(z.string().uuid('Choose a location from the list.')),
    lat: single(latitude),
    lng: single(longitude),
    radius: radiusInput,
    verified: flagInput.optional(),
    minRating: single(z.enum(MIN_RATING_OPTIONS, { message: 'Choose a rating from the list.' })),
    delivers: flagInput.optional(),
    cursor: single(cursorToken),
    limit: z.preprocess(first, z.coerce.number().int().min(1).max(SEARCH_PAGE_MAX).default(20)),
  })
  .superRefine((v, ctx) => {
    if ((v.lat === undefined) !== (v.lng === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['lat'], message: 'Location could not be read.' });
    }
  })
  .transform((v) => ({
    place: v.place,
    point: v.lat !== undefined && v.lng !== undefined ? { lat: v.lat, lng: v.lng } : undefined,
    // Default radius 25 km; explicit "national" removes the distance limit.
    radiusKm: v.radius === undefined ? 25 : v.radius,
    verifiedOnly: v.verified ?? false,
    minRating: v.minRating ? Number(v.minRating) : undefined,
    deliversToMe: v.delivers ?? false,
    cursor: v.cursor,
    limit: v.limit,
  }));
export type NearbyFiltersInput = z.input<typeof nearbyFiltersInput>;
export type NearbyFilters = z.output<typeof nearbyFiltersInput>;

export const placeSearchInput = z.object({
  q: z
    .string({ message: 'Type a city, area or state.' })
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(2, 'Type at least 2 letters of a city, area or state.').max(60, 'Keep it under 60 characters.')),
});

/** Device coordinates sent once to resolve the nearest reference place. Never stored. */
export const deviceLocationInput = z.object({ lat: latitude, lng: longitude });

/** Choose a delivery location: a place id from the typeahead, or typed text resolved to the best match. */
export const chooseLocationInput = z
  .object({
    placeId: single(z.string().uuid('Choose a location from the list.')),
    where: single(z.string().trim().max(60, 'Keep it under 60 characters.')),
  })
  .superRefine((v, ctx) => {
    if (!v.placeId && (!v.where || v.where.length < 2)) {
      ctx.addIssue({ code: 'custom', path: ['where'], message: 'Type at least 2 letters of a city, area or state.' });
    }
  });

/** The buyer's chosen delivery location as stored in the `tm_loc` cookie. No coordinates. */
export const locationPreferenceSchema = z.object({
  placeId: z.string().uuid(),
  name: z.string().min(1).max(80),
  state: z.enum(NIGERIAN_STATES),
  city: z.string().max(80),
});
export type LocationPreferenceShape = z.infer<typeof locationPreferenceSchema>;

export const savedItemsInput = z.object({
  cursor: single(cursorToken),
  limit: z.preprocess(first, z.coerce.number().int().min(1).max(SEARCH_PAGE_MAX).default(SEARCH_PAGE_DEFAULT)),
});
