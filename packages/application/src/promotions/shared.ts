import { DomainError } from '@thrift/domain';
import { maybeOne, type Queryable } from '@thrift/database';
import { notifyUser } from '../notifications/notify';

/**
 * Paid promotion (R22). Lock order for promotion money: ad_campaigns → payment_attempts → refunds.
 * Commercial rules that are still owner decisions (D05 pricing, D10 eligibility and refunds for unused time) are
 * not invented here: money is returned automatically only when no promotion was delivered (rejected, cancelled
 * before going live, or paid after the booking lapsed); anything else is a staff request with four-eyes approval.
 */
export interface CampaignRow {
  id: string;
  shop_id: string;
  package_id: string;
  target_kind: 'listing' | 'shop';
  listing_id: string | null;
  placement: 'home_feed' | 'search_results' | 'nearby';
  status: 'awaiting_payment' | 'pending_review' | 'scheduled' | 'active' | 'paused' | 'ended' | 'rejected' | 'cancelled';
  price_minor: number;
  currency: string;
  starts_at: Date | null;
  ends_at: Date | null;
  ended_at: Date | null;
  paid_at: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_reason: string | null;
  end_reason: string | null;
  refund_minor: number;
  created_by: string | null;
  created_at: Date;
  [k: string]: unknown;
}

export const PROMOTIONS_PATH = '/sell/promotions';

export const PLACEMENT_LABEL: Record<CampaignRow['placement'], string> = {
  home_feed: 'Home feed',
  search_results: 'Search results',
  nearby: 'Nearby shops',
};

export async function lockCampaign(tx: Queryable, campaignId: string): Promise<CampaignRow> {
  const c = await maybeOne<CampaignRow>(tx, 'SELECT * FROM ad_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
  if (!c) throw new DomainError('NOT_FOUND', 'Promotion not found.');
  return c;
}

/** Notifies the shop owner about their promotion (transactional: it concerns money they paid). */
export async function notifyShopOwner(
  tx: Queryable,
  shopId: string,
  n: { kind: string; title: string; body: string; dedupeKey: string },
): Promise<void> {
  const owner = await maybeOne<{ owner_user_id: string }>(tx, 'SELECT owner_user_id FROM shops WHERE id = $1', [shopId]);
  if (!owner) return;
  await notifyUser(tx, { userId: owner.owner_user_id, topic: 'transactional', kind: n.kind, title: n.title, body: n.body, link: PROMOTIONS_PATH, dedupeKey: n.dedupeKey });
}

/**
 * The share of a promotion's paid time that wasn't delivered because it stopped early. Informational: it guides a
 * staff refund request, it never moves money by itself.
 */
export function unusedPortion(c: Pick<CampaignRow, 'starts_at' | 'ends_at' | 'ended_at' | 'price_minor'>): { unusedMinor: number; unusedHours: number } {
  if (!c.starts_at || !c.ends_at || !c.ended_at) return { unusedMinor: 0, unusedHours: 0 };
  const total = new Date(c.ends_at).getTime() - new Date(c.starts_at).getTime();
  const unused = new Date(c.ends_at).getTime() - new Date(c.ended_at).getTime();
  if (total <= 0 || unused <= 0) return { unusedMinor: 0, unusedHours: 0 };
  return { unusedMinor: Math.floor((c.price_minor * unused) / total), unusedHours: Math.floor(unused / 3_600_000) };
}
