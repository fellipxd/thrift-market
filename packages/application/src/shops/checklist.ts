import { maybeOne, type Queryable } from '@thrift/database';

export type ChecklistKey = 'profile' | 'coverage' | 'payout' | 'verification' | 'first_listing';

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  done: boolean;
  /** Required before the shop can open. Verification and the first listing are recommended, not required. */
  required: boolean;
  hint: string;
  /** Short status text for the current state (e.g. "Pending review"). */
  status: string;
}

export interface OnboardingChecklist {
  shopId: string;
  shopStatus: 'draft' | 'active' | 'paused' | 'suspended';
  items: ChecklistItem[];
  readyToPublish: boolean;
  /** Every item (required and recommended) is done. */
  complete: boolean;
}

interface Row {
  status: OnboardingChecklist['shopStatus'];
  bio: string;
  returns_policy: string;
  created_at: Date;
  verification_status: string;
  coverage_updated_at: Date | null;
  payout_status: string | null;
  published_listings: number;
  [k: string]: unknown;
}

const VERIFICATION_STATUS_TEXT: Record<string, string> = {
  unverified: 'Not started',
  pending: 'Under review',
  approved: 'Verified',
  rejected: 'Not approved — you can submit again',
  reverification: 'Re-check requested',
  suspended: 'Suspended',
};

export async function computeChecklist(db: Queryable, shopId: string): Promise<OnboardingChecklist> {
  const r = await maybeOne<Row>(
    db,
    `SELECT s.status, s.bio, s.returns_policy, s.created_at, s.verification_status,
            c.updated_at AS coverage_updated_at,
            (SELECT p.status FROM payout_accounts p WHERE p.shop_id = s.id AND p.status IN ('pending','verified') LIMIT 1) AS payout_status,
            (SELECT count(*)::int FROM listings l WHERE l.shop_id = s.id AND l.status NOT IN ('draft','removed')) AS published_listings
       FROM shops s LEFT JOIN delivery_coverage c ON c.shop_id = s.id
      WHERE s.id = $1`,
    [shopId],
  );
  if (!r) throw new Error(`shop ${shopId} not found`);
  const profileDone = r.bio.trim().length >= 10 && r.returns_policy.trim().length >= 10;
  // The default coverage row is written in the same transaction as the shop (same now()), so a later
  // updated_at means the seller has reviewed and saved their coverage at least once.
  const coverageDone = r.coverage_updated_at !== null && new Date(r.coverage_updated_at).getTime() > new Date(r.created_at).getTime();
  const items: ChecklistItem[] = [
    {
      key: 'profile',
      label: 'Shop profile',
      done: profileDone,
      required: true,
      hint: 'Add a short bio and your returns policy so buyers know what to expect.',
      status: profileDone ? 'Done' : 'Bio or returns policy missing',
    },
    {
      key: 'coverage',
      label: 'Delivery coverage',
      done: coverageDone,
      required: true,
      hint: 'Confirm where you deliver, how, and what seller-arranged delivery costs.',
      status: coverageDone ? 'Done' : 'Not confirmed yet',
    },
    {
      key: 'payout',
      label: 'Payout account',
      done: r.payout_status !== null,
      required: true,
      hint: 'Add the bank account that receives your payouts.',
      status: r.payout_status === 'verified' ? 'Added' : r.payout_status === 'pending' ? 'Added — name check pending' : 'Not added',
    },
    {
      key: 'verification',
      label: 'Identity verification',
      done: r.verification_status === 'approved',
      required: false,
      hint: 'Optional but recommended: an identity check adds a dated “Identity checked” note to your shop.',
      status: VERIFICATION_STATUS_TEXT[r.verification_status] ?? r.verification_status,
    },
    {
      key: 'first_listing',
      label: 'First listing',
      done: r.published_listings > 0,
      required: false,
      hint: 'Publish your first piece once your shop is open.',
      status: r.published_listings > 0 ? `${r.published_listings} published` : 'None yet',
    },
  ];
  const readyToPublish = items.filter((i) => i.required).every((i) => i.done);
  return { shopId, shopStatus: r.status, items, readyToPublish, complete: items.every((i) => i.done) && r.status === 'active' };
}
