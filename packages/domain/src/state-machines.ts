import { DomainError } from './errors';

type Machine<S extends string> = Readonly<Record<S, readonly S[]>>;

function define<S extends string>(m: Record<S, readonly NoInfer<S>[]>): Machine<S> {
  return m;
}

export const ORDER_STATUS = define({
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
});
export type OrderStatus = keyof typeof ORDER_STATUS;

export const PAYMENT_STATUS = define({
  pending: ['paid', 'failed'],
  failed: ['paid'], // a late but verified success after a failed attempt
  paid: ['refund_pending', 'partially_refunded', 'refunded'],
  refund_pending: ['partially_refunded', 'refunded', 'paid'],
  partially_refunded: ['refund_pending', 'refunded'],
  refunded: [],
});
export type PaymentStatus = keyof typeof PAYMENT_STATUS;

export const FULFILMENT_STATUS = define({
  unfulfilled: ['awaiting_dispatch', 'cancelled'],
  awaiting_dispatch: ['dispatched', 'in_transit', 'delivered', 'cancelled', 'delivery_exception'],
  dispatched: ['in_transit', 'delivered', 'delivery_exception', 'returned'],
  in_transit: ['in_transit', 'delivered', 'delivery_exception', 'returned'],
  delivery_exception: ['in_transit', 'delivered', 'returned', 'cancelled'],
  delivered: ['returned'],
  returned: [],
  cancelled: [],
});
export type FulfilmentStatus = keyof typeof FULFILMENT_STATUS;

export const PAYOUT_STATUS = define({
  held: ['eligible', 'blocked', 'cancelled'],
  blocked: ['held', 'eligible', 'cancelled'],
  eligible: ['processing', 'blocked', 'held'],
  processing: ['paid', 'failed'],
  failed: ['eligible', 'blocked'],
  paid: ['reversed'],
  reversed: [],
  cancelled: [],
});
export type PayoutStatus = keyof typeof PAYOUT_STATUS;

export const SHIPMENT_STATUS = define({
  pending: ['booked', 'picked_up', 'in_transit', 'delivered', 'cancelled', 'exception'],
  booked: ['picked_up', 'in_transit', 'cancelled', 'exception'],
  picked_up: ['in_transit', 'out_for_delivery', 'delivered', 'exception'],
  in_transit: ['in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned'],
  out_for_delivery: ['delivered', 'exception', 'returned'],
  exception: ['in_transit', 'out_for_delivery', 'delivered', 'returned', 'cancelled'],
  delivered: [],
  returned: [],
  cancelled: [],
});
export type ShipmentStatus = keyof typeof SHIPMENT_STATUS;

export const DISPUTE_STATUS = define({
  awaiting_seller: ['awaiting_buyer', 'under_review', 'resolved', 'withdrawn'],
  awaiting_buyer: ['awaiting_seller', 'under_review', 'resolved', 'withdrawn'],
  under_review: ['awaiting_seller', 'awaiting_buyer', 'resolved'],
  resolved: ['appealed'],
  appealed: ['resolved'],
  withdrawn: [],
});
export type DisputeStatus = keyof typeof DISPUTE_STATUS;

export const REFUND_STATUS = define({
  requested: ['approved', 'rejected'],
  approved: ['processing'],
  processing: ['succeeded', 'failed'],
  failed: ['processing'],
  succeeded: [],
  rejected: [],
});
export type RefundStatus = keyof typeof REFUND_STATUS;

export const RESERVATION_STATUS = define({
  active: ['payment_pending', 'converted', 'released', 'expired'],
  payment_pending: ['converted', 'released', 'expired'],
  converted: [],
  released: [],
  expired: [],
});
export type ReservationStatus = keyof typeof RESERVATION_STATUS;

export const AUCTION_STATUS = define({
  draft: ['scheduled', 'cancelled'],
  scheduled: ['live', 'cancelled'],
  live: ['ended_no_bids', 'awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'failed_unpaid'],
  ended_no_bids: [],
  paid: [],
  failed_unpaid: [],
  cancelled: [],
});

export const AD_CAMPAIGN_STATUS = define({
  awaiting_payment: ['pending_review', 'cancelled'],
  pending_review: ['scheduled', 'active', 'rejected'],
  scheduled: ['active', 'cancelled', 'ended'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: [],
  rejected: [],
  cancelled: [],
});

export function canTransition<S extends string>(machine: Machine<S>, from: S, to: S): boolean {
  return (machine[from] ?? []).includes(to);
}

export function assertTransition<S extends string>(machine: Machine<S>, from: S, to: S, what = 'state'): void {
  if (!canTransition(machine, from, to)) {
    throw new DomainError('INVALID_STATE', `Cannot change ${what} from ${from} to ${to}.`, { from, to });
  }
}
