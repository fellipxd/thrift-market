import { z } from 'zod';
import { nairaInput, uuid } from './common';

/** Up to `max` media ids from a form (repeated fields joined with commas) or an API array. */
const mediaIds = (max: number) =>
  z.preprocess(
    (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v === undefined || v === null ? [] : v),
    z.array(uuid).max(max, `Attach up to ${max} photos.`),
  );

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim() || undefined : v), z.string().max(max).optional());

export const markDispatchedInput = z.object({
  orderId: uuid,
  carrierName: optionalText(80),
  trackingReference: optionalText(80),
  note: optionalText(300),
  proofMediaId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
});
export type MarkDispatchedInput = z.output<typeof markDispatchedInput>;

export const staffVerifyDeliveryInput = z.object({
  orderId: uuid,
  reason: z.string({ message: 'Record why delivery is verified.' }).trim().min(10, 'Give the evidence you relied on (at least 10 characters).').max(1000),
});

export const DISPUTE_REASONS = ['not_delivered', 'undisclosed_defect', 'wrong_item', 'transit_damage', 'other'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export const DISPUTE_REASON_LABEL: Record<DisputeReason, string> = {
  not_delivered: 'Item not delivered',
  undisclosed_defect: 'Flaw or damage that wasn’t disclosed',
  wrong_item: 'Wrong item received',
  transit_damage: 'Damaged in transit',
  other: 'Something else',
};

export const openDisputeInput = z.object({
  orderId: uuid,
  reason: z.enum(DISPUTE_REASONS, { message: 'Choose what went wrong.' }),
  description: z.string({ message: 'Describe the problem.' }).trim().min(10, 'Describe the problem (at least 10 characters).').max(2000),
  evidenceMediaIds: mediaIds(6),
});
export type OpenDisputeInput = z.output<typeof openDisputeInput>;

export const disputeIdInput = z.object({ disputeId: uuid });

export const respondToDisputeInput = z
  .object({
    disputeId: uuid,
    response: z.enum(['accept_full_refund', 'offer_partial_refund', 'reject'], { message: 'Choose a response.' }),
    amount: z.preprocess((v) => (v === '' || v === null ? undefined : v), nairaInput.optional()),
    message: optionalText(2000),
    evidenceMediaIds: mediaIds(6),
  })
  .superRefine((v, ctx) => {
    if (v.response === 'offer_partial_refund' && (v.amount === undefined || v.amount <= 0)) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Enter the refund you’re offering in naira.' });
    }
    if (v.response === 'reject' && (!v.message || v.message.length < 10)) {
      ctx.addIssue({ code: 'custom', path: ['message'], message: 'Explain why (at least 10 characters).' });
    }
  });
export type RespondToDisputeInput = z.output<typeof respondToDisputeInput>;

export const buyerPartialDecisionInput = z.object({
  disputeId: uuid,
  decision: z.enum(['accept', 'escalate']),
  message: optionalText(2000),
});

export const DISPUTE_OUTCOMES = ['full_refund', 'partial_refund', 'return_and_refund', 'no_refund'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export const decideDisputeInput = z
  .object({
    disputeId: uuid,
    outcome: z.enum(DISPUTE_OUTCOMES, { message: 'Choose an outcome.' }),
    refundAmount: z.preprocess((v) => (v === '' || v === null ? undefined : v), nairaInput.optional()),
    reason: z.string({ message: 'Record the reason for the decision.' }).trim().min(10, 'Record the reason for the decision (at least 10 characters).').max(2000),
    returnInstructions: optionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === 'partial_refund' && (v.refundAmount === undefined || v.refundAmount <= 0)) {
      ctx.addIssue({ code: 'custom', path: ['refundAmount'], message: 'Enter the partial refund in naira.' });
    }
  });
export type DecideDisputeInput = z.output<typeof decideDisputeInput>;

export const appealDisputeInput = z.object({
  disputeId: uuid,
  reason: z.string({ message: 'Explain why you’re appealing.' }).trim().min(10, 'Explain why you’re appealing (at least 10 characters).').max(2000),
});

export const addDisputeEntryInput = z.object({
  disputeId: uuid,
  body: z.string({ message: 'Write a message.' }).trim().min(1, 'Write a message.').max(2000),
  evidenceMediaIds: mediaIds(6),
  internal: z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean()).default(false),
});
