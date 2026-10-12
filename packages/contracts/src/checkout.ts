import { z } from 'zod';
import { idempotencyKey, uuid } from './common';

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

export const orderIdInput = z.object({ orderId: uuid });

export const sellerCancelInput = z.object({
  orderId: uuid,
  reason: z.string({ message: 'Tell the buyer why.' }).trim().min(10, 'Give a short reason (at least 10 characters).').max(500),
  restock: z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean()).default(false),
});

export const REFUND_REASONS = ['buyer_cancelled', 'seller_cancelled', 'dispute_upheld', 'late_payment_after_release', 'duplicate_payment', 'not_delivered', 'staff_exception'] as const;
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
