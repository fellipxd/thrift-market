export type ReputationTier = 'new' | 'established' | 'trusted' | 'under_review';

export interface ReputationInputs {
  completedOrders: number;
  reviewCount: number;
  ratingSum: number;
  onTimeDispatches: number;
  dispatchesMeasured: number;
  sellerCancellations: number;
  upheldDisputes: number;
}

/** Draft thresholds — calibration is an open decision (D10). */
export const REPUTATION_THRESHOLDS = {
  establishedMinOrders: 5,
  trustedMinOrders: 25,
  trustedMinScore: 80,
  priorMean: 3.8,
  priorWeight: 5,
};

/**
 * Sample-aware score (0-100). Ratings use a Bayesian average so one five-star review does not
 * outrank a proven shop; dispatch timeliness, cancellations and upheld disputes adjust the score.
 */
export function computeReputation(i: ReputationInputs): { score: number | null; ratingAvg: number | null; tier: ReputationTier } {
  const t = REPUTATION_THRESHOLDS;
  const ratingAvg = i.reviewCount > 0 ? Math.round((i.ratingSum / i.reviewCount) * 100) / 100 : null;
  if (i.completedOrders === 0 && i.reviewCount === 0) return { score: null, ratingAvg, tier: 'new' };
  const bayes = (t.priorMean * t.priorWeight + i.ratingSum) / (t.priorWeight + i.reviewCount);
  const ratingComponent = ((bayes - 1) / 4) * 70; // up to 70
  const dispatchRate = i.dispatchesMeasured > 0 ? i.onTimeDispatches / i.dispatchesMeasured : 0.8;
  const dispatchComponent = dispatchRate * 30; // up to 30
  const orders = Math.max(i.completedOrders, 1);
  const cancellationPenalty = Math.min(25, (i.sellerCancellations / orders) * 100);
  const disputePenalty = Math.min(35, (i.upheldDisputes / orders) * 150);
  const score = Math.max(0, Math.min(100, ratingComponent + dispatchComponent - cancellationPenalty - disputePenalty));
  const rounded = Math.round(score * 100) / 100;
  let tier: ReputationTier = 'new';
  if (i.completedOrders >= t.trustedMinOrders && rounded >= t.trustedMinScore) tier = 'trusted';
  else if (i.completedOrders >= t.establishedMinOrders) tier = 'established';
  if (i.completedOrders >= 5 && (i.upheldDisputes / orders > 0.15 || i.sellerCancellations / orders > 0.2)) tier = 'under_review';
  return { score: rounded, ratingAvg, tier };
}

export const REPUTATION_TIER_LABEL: Record<ReputationTier, string> = {
  new: 'New seller',
  established: 'Established seller',
  trusted: 'Trusted seller',
  under_review: 'Service under review',
};
