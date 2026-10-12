import { z } from 'zod';
import { idempotencyKey, nairaInput, uuid } from './common';

/** West Africa Time is UTC+1 all year (Africa/Lagos has no daylight saving). */
const WAT_OFFSET_MINUTES = 60;

function watParts(d: Date): { y: number; mo: number; da: number; h: number; mi: number } {
  const shifted = new Date(d.getTime() + WAT_OFFSET_MINUTES * 60_000);
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, da: shifted.getUTCDate(), h: shifted.getUTCHours(), mi: shifted.getUTCMinutes() };
}

/**
 * Parses a seller-entered auction time. Accepts either a full ISO-8601 timestamp with a zone
 * (API clients: "2026-10-20T18:00:00Z" / "...+01:00") or a `datetime-local` value without a zone
 * ("2026-10-20T19:00"), which is interpreted as West Africa Time. Output is a UTC Date.
 */
export function parseWatDateTime(raw: string): Date | null {
  const v = raw.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (local) {
    const [, y, mo, da, h, mi, s] = local;
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s ?? 0)) - WAT_OFFSET_MINUTES * 60_000;
    const d = new Date(ms);
    // Reject impossible calendar values (e.g. 30 February) that Date would silently roll over.
    const p = watParts(d);
    if (p.y !== Number(y) || p.mo !== Number(mo) || p.da !== Number(da) || p.h !== Number(h) || p.mi !== Number(mi)) return null;
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Formats a UTC instant as a `datetime-local` value in WAT ("2026-10-20T19:00"). */
export function toWatDateTimeLocal(d: Date): string {
  const p = watParts(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.da)}T${pad(p.h)}:${pad(p.mi)}`;
}

export const watDateTime = z
  .string({ error: 'Choose a date and time' })
  .trim()
  .min(1, 'Choose a date and time')
  .max(40)
  .transform((v, ctx) => {
    const d = parseWatDateTime(v);
    if (!d) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid date and time (WAT)' });
      return z.NEVER;
    }
    return d;
  });

/** Auction start: an explicit time, or "now" (resolved to authoritative server time by the use case). */
export const auctionStart = z.union([z.literal('now'), watDateTime]);

const amount = (label: string) =>
  nairaInput.pipe(z.number().int().positive(`Enter ${label} above ₦0`).max(100_000_000_000, `${label[0]!.toUpperCase()}${label.slice(1)} is too large`));

export const createAuctionInput = z.object({
  listingId: uuid,
  startsAt: auctionStart,
  endsAt: watDateTime,
  openingPrice: amount('an opening price'),
  increment: amount('a bid increment'),
});
export type CreateAuctionInput = z.infer<typeof createAuctionInput>;

export const relistAuctionInput = createAuctionInput.omit({ listingId: true }).extend({ auctionId: uuid });
export type RelistAuctionInput = z.infer<typeof relistAuctionInput>;

export const cancelAuctionInput = z.object({
  auctionId: uuid,
  reason: z.string().trim().min(3, 'Tell bidders-to-be why (at least 3 characters)').max(300, 'Keep the reason under 300 characters'),
});
export type CancelAuctionInput = z.infer<typeof cancelAuctionInput>;

export const placeBidInput = z.object({
  auctionId: uuid,
  amount: amount('a bid amount'),
  idempotencyKey,
  /** Optional: bid with a specific saved address instead of the default one. */
  addressId: uuid.optional(),
});
export type PlaceBidInput = z.infer<typeof placeBidInput>;

export const auctionIdInput = z.object({ auctionId: uuid });
export const secondChanceOfferIdInput = z.object({ offerId: uuid });

export const AUCTION_LIST_STATUSES = ['live', 'upcoming', 'ended'] as const;
export const listAuctionsInput = z.object({
  status: z.enum(AUCTION_LIST_STATUSES).default('live'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});
export type ListAuctionsInput = z.infer<typeof listAuctionsInput>;
