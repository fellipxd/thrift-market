import { addMoney, apportionMinor, applyBps } from './money';

/**
 * Commission, buyer fee and payer are open owner decisions (D05). Defaults are zero and
 * configurable through platform_settings; checkout always itemises whatever applies.
 */
export interface FeeSettings {
  commissionBps: number;
  buyerFeeBps: number;
  buyerFeeFlatMinor: number;
}

export const ZERO_FEES: FeeSettings = { commissionBps: 0, buyerFeeBps: 0, buyerFeeFlatMinor: 0 };

export interface OrderTotals {
  itemsTotalMinor: number;
  shippingMinor: number;
  buyerFeeMinor: number;
  totalMinor: number;
  commissionMinor: number;
  sellerProceedsMinor: number;
}

export interface OrderLine {
  unitPriceMinor: number;
  quantity: number;
}

/**
 * Totals for one order: one or more lines from the same seller, one delivery fee for the shipment, and fees on the
 * items total (so a combined order never pays a flat fee per piece).
 */
export function computeOrderTotals(
  args: ({ lines: readonly OrderLine[] } | OrderLine) & { shippingMinor: number; fees: FeeSettings; shippingPaidToSeller: boolean },
): OrderTotals {
  const lines = 'lines' in args ? args.lines : [{ unitPriceMinor: args.unitPriceMinor, quantity: args.quantity }];
  const itemsTotalMinor = addMoney(...lines.map((l) => l.unitPriceMinor * l.quantity));
  const buyerFeeMinor = addMoney(applyBps(itemsTotalMinor, args.fees.buyerFeeBps), args.fees.buyerFeeFlatMinor);
  const commissionMinor = applyBps(itemsTotalMinor, args.fees.commissionBps);
  const totalMinor = addMoney(itemsTotalMinor, args.shippingMinor, buyerFeeMinor);
  const sellerProceedsMinor = itemsTotalMinor - commissionMinor + (args.shippingPaidToSeller ? args.shippingMinor : 0);
  return { itemsTotalMinor, shippingMinor: args.shippingMinor, buyerFeeMinor, totalMinor, commissionMinor, sellerProceedsMinor };
}

export interface LineShares {
  shippingShareMinor: number;
  buyerFeeShareMinor: number;
  commissionShareMinor: number;
}

/**
 * Frozen per-line split of the order-level delivery fee, buyer fee and commission, weighted by each line's items
 * total (largest remainder). Stored with the order so a later partial refund uses the split the buyer accepted.
 */
export function apportionOrderTotals(totals: Pick<OrderTotals, 'shippingMinor' | 'buyerFeeMinor' | 'commissionMinor'>, lines: readonly OrderLine[]): LineShares[] {
  const weights = lines.map((l) => l.unitPriceMinor * l.quantity);
  const shipping = apportionMinor(totals.shippingMinor, weights);
  const buyerFee = apportionMinor(totals.buyerFeeMinor, weights);
  const commission = apportionMinor(totals.commissionMinor, weights);
  return lines.map((_, i) => ({ shippingShareMinor: shipping[i]!, buyerFeeShareMinor: buyerFee[i]!, commissionShareMinor: commission[i]! }));
}
