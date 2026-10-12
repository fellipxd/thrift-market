import { z } from 'zod';
import { uuid } from './common';

const rating = (label: string) => z.coerce.number({ message: `Rate ${label}.` }).int().min(1, `Rate ${label} from 1 to 5.`).max(5, `Rate ${label} from 1 to 5.`);

export const submitReviewInput = z.object({
  orderItemId: uuid,
  overall: rating('your overall experience'),
  accuracy: rating('how accurately the item was described'),
  communication: rating('communication'),
  delivery: rating('delivery'),
  body: z.preprocess((v) => (typeof v === 'string' ? v.trim() : ''), z.string().max(1500, 'Keep your review under 1,500 characters.')),
});
export type SubmitReviewInput = z.output<typeof submitReviewInput>;

export const sellerReplyInput = z.object({
  reviewId: uuid,
  reply: z.string({ message: 'Write a reply.' }).trim().min(2, 'Write a reply.').max(1000, 'Keep your reply under 1,000 characters.'),
});

const reason = z.string({ message: 'Give a reason.' }).trim().min(10, 'Give a specific reason (at least 10 characters).').max(1000);

export const moderateReviewInput = z.object({
  reviewId: uuid,
  action: z.enum(['hide', 'remove', 'restore']),
  reason,
});

export const REPORT_KINDS = ['listing', 'shop', 'user', 'message', 'review'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_REASONS = ['counterfeit', 'stolen', 'prohibited', 'misleading', 'harassment', 'spam', 'fraud', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  counterfeit: 'Counterfeit or fake branded item',
  stolen: 'Possibly stolen goods',
  prohibited: 'Prohibited item',
  misleading: 'Misleading description or photos',
  harassment: 'Harassment or abuse',
  spam: 'Spam or scam messages',
  fraud: 'Fraud or asking to pay outside checkout',
  other: 'Something else',
};

export const submitReportInput = z.object({
  kind: z.enum(REPORT_KINDS, { message: 'Unknown report type.' }),
  id: uuid,
  reason: z.enum(REPORT_REASONS, { message: 'Choose a reason.' }),
  details: z.preprocess((v) => (typeof v === 'string' ? v.trim() : ''), z.string().max(2000, 'Keep details under 2,000 characters.')),
});
export type SubmitReportInput = z.output<typeof submitReportInput>;

export const MODERATION_ACTIONS = ['remove_listing', 'suspend_shop', 'hide_message', 'hide_review', 'suspend_user', 'dismiss'] as const;
export type ModerationActionKind = (typeof MODERATION_ACTIONS)[number];

export const actOnReportInput = z.object({
  reportId: uuid,
  action: z.enum(MODERATION_ACTIONS, { message: 'Choose an action.' }),
  reason,
});

export const reverseModerationInput = z.object({
  actionId: uuid,
  reason,
});

export const notificationIdInput = z.object({ notificationId: uuid });

export const followDropsInput = z.object({
  shopId: uuid,
  notifyDrops: z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean()),
});
