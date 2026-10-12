import { z } from 'zod';
import { nairaInput, uuid } from './common';

const reason = z.string({ message: 'Give a reason.' }).trim().min(10, 'Give a reason (at least 10 characters).').max(1000);

export const AD_PLACEMENTS = ['home_feed', 'search_results', 'nearby'] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

export const AD_CAMPAIGN_STATUSES = ['awaiting_payment', 'pending_review', 'scheduled', 'active', 'paused', 'ended', 'rejected', 'cancelled'] as const;
export type AdCampaignStatus = (typeof AD_CAMPAIGN_STATUSES)[number];

/** Book a package for one listing (listing packages) or the whole shop (shop packages). */
export const createCampaignInput = z.object({
  packageId: uuid,
  listingId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
});

export const campaignIdInput = z.object({ campaignId: uuid });

export const reviewCampaignInput = z.object({
  campaignId: uuid,
  decision: z.enum(['approve', 'reject'], { message: 'Choose approve or reject.' }),
  reason,
});

/** Staff stop a running promotion (e.g. policy breach found after approval). Any refund is a separate finance decision. */
export const staffEndCampaignInput = z.object({ campaignId: uuid, reason });

/** Staff request a refund of an early-ended promotion's unused time (four-eyes approval in finance). */
export const promotionRefundRequestInput = z.object({
  campaignId: uuid,
  /** Naira from the form; parsed to integer kobo. */
  amount: nairaInput,
  note: reason,
});
