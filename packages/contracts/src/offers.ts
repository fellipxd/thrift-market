import { z } from 'zod';
import { idempotencyKey, nairaInput, uuid } from './common';

export const OFFER_NOTE_MAX_LENGTH = 280;

const note = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z
    .string()
    .max(OFFER_NOTE_MAX_LENGTH, `Notes can be up to ${OFFER_NOTE_MAX_LENGTH} characters.`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
);

/** Amount in naira from a form ("8,500") → integer kobo. Empty or missing values get a clear message. */
const requiredNaira = z.preprocess((v) => (v === undefined || v === null ? '' : v), nairaInput);
const optionalNaira = z.preprocess((v) => (v === '' || v === null ? undefined : v), nairaInput.optional());

export const makeOfferInput = z.object({
  listingId: uuid,
  amount: requiredNaira,
  note,
  idempotencyKey,
});
export type MakeOfferInput = z.infer<typeof makeOfferInput>;

export const offerAction = z.enum(['accept', 'reject', 'counter', 'withdraw']);

export const respondToOfferInput = z
  .object({
    offerId: uuid,
    action: offerAction,
    counterAmount: optionalNaira,
    note,
    idempotencyKey: z.preprocess((v) => (v === '' ? undefined : v), idempotencyKey.optional()),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'counter' && v.counterAmount === undefined) {
      ctx.addIssue({ code: 'custom', path: ['counterAmount'], message: 'Enter your counteroffer in naira.' });
    }
  });
export type RespondToOfferInput = z.infer<typeof respondToOfferInput>;

export const shopOffersInput = z.object({
  status: z.enum(['needs_response', 'awaiting_buyer', 'accepted', 'closed', 'all']).default('needs_response'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ShopOffersInput = z.infer<typeof shopOffersInput>;
