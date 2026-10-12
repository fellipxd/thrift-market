import { z } from 'zod';
import { idempotencyKey, minorAmount, uuid } from './common';

export const DELIVERY_METHODS = ['integrated', 'seller_arranged', 'pickup'] as const;

const quantity = z.coerce.number({ message: 'Choose a quantity.' }).int('Choose a whole number.').min(1, 'Choose at least 1.').max(500, 'At most 500.');

export const startCheckoutInput = z.object({
  listingId: uuid,
  quantity: z.preprocess((v) => (v === undefined || v === '' ? 1 : v), quantity),
  addressId: z.string({ message: 'Choose a delivery address.' }).uuid('Choose a delivery address.'),
  deliveryMethod: z.enum(DELIVERY_METHODS, { message: 'Choose how you want it delivered.' }),
  idempotencyKey,
});
export type StartCheckoutInput = z.output<typeof startCheckoutInput>;

export const reservationCheckoutInput = z.object({
  reservationId: uuid,
  addressId: z.string({ message: 'Choose a delivery address.' }).uuid('Choose a delivery address.'),
  deliveryMethod: z.enum(DELIVERY_METHODS, { message: 'Choose how you want it delivered.' }),
  idempotencyKey,
});
export type ReservationCheckoutInput = z.output<typeof reservationCheckoutInput>;

/** Saves a piece to the bag (or changes its quantity). The bag is interest only and never holds stock. */
export const bagItemInput = z.object({
  listingId: uuid,
  quantity: z.preprocess((v) => (v === undefined || v === '' ? 1 : v), quantity),
});
export const bagRemoveInput = z.object({ listingId: uuid });

/** Most pieces one bag checkout can hold; the buyer's active-hold limit can make the real cap lower. */
export const MAX_BAG_CHECKOUT_ITEMS = 20;

/**
 * Same-seller bag checkout. The buyer confirms the exact pieces, quantities and unit prices they saw; the server
 * holds every piece or none, and refuses if any price changed so the buyer can review the new total.
 */
export const bagCheckoutInput = z.object({
  shopId: uuid,
  items: z
    .array(z.object({ listingId: uuid, quantity, expectedUnitPriceMinor: z.coerce.number().pipe(minorAmount) }))
    .min(1, 'Your bag has no pieces from this shop.')
    .max(MAX_BAG_CHECKOUT_ITEMS, `Check out at most ${MAX_BAG_CHECKOUT_ITEMS} pieces at a time.`)
    .refine((items) => new Set(items.map((i) => i.listingId)).size === items.length, 'Each piece can appear only once.'),
  addressId: z.string({ message: 'Choose a delivery address.' }).uuid('Choose a delivery address.'),
  deliveryMethod: z.enum(DELIVERY_METHODS, { message: 'Choose how you want it delivered.' }),
  idempotencyKey,
});
export type BagCheckoutInput = z.output<typeof bagCheckoutInput>;

export const orderIdInput = z.object({ orderId: uuid });

export const sellerCancelInput = z.object({
  orderId: uuid,
  reason: z.string({ message: 'Tell the buyer why.' }).trim().min(10, 'Give a short reason (at least 10 characters).').max(500),
  restock: z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean()).default(false),
});

export const REFUND_REASONS = [
  'buyer_cancelled',
  'seller_cancelled',
  'dispute_upheld',
  'late_payment_after_release',
  'duplicate_payment',
  'not_delivered',
  'staff_exception',
  'promotion_rejected',
  'promotion_cancelled',
  'promotion_ended_early',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const staffRefundInput = z.object({
  orderId: uuid,
  amountMinor: z.coerce.number().int().positive(),
  note: z.string().trim().min(10, 'Explain the exception (at least 10 characters).').max(1000),
});

export const refundDecisionInput = z.object({
  refundId: uuid,
  decision: z.enum(['approve', 'reject'], { message: 'Choose approve or reject.' }),
  reason: z.string().trim().min(5, 'Give a reason.').max(1000),
});
