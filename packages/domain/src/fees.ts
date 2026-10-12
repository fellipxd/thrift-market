import { applyBps, addMoney } from './money';

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

export function computeOrderTotals(args: {
  unitPriceMinor: number;
  quantity: number;
  shippingMinor: number;
  fees: FeeSettings;
  shippingPaidToSeller: boolean;
}): OrderTotals {
  const itemsTotalMinor = args.unitPriceMinor * args.quantity;
  const buyerFeeMinor = addMoney(applyBps(itemsTotalMinor, args.fees.buyerFeeBps), args.fees.buyerFeeFlatMinor);
  const commissionMinor = applyBps(itemsTotalMinor, args.fees.commissionBps);
  const totalMinor = addMoney(itemsTotalMinor, args.shippingMinor, buyerFeeMinor);
  const sellerProceedsMinor = itemsTotalMinor - commissionMinor + (args.shippingPaidToSeller ? args.shippingMinor : 0);
  return { itemsTotalMinor, shippingMinor: args.shippingMinor, buyerFeeMinor, totalMinor, commissionMinor, sellerProceedsMinor };
}
