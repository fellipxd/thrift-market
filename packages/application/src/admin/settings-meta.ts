import type { SettingKey } from '@thrift/domain';

/** Labels, units and allowed ranges for platform settings (all values are draft operational parameters). */
export const SETTING_META: Record<SettingKey, { label: string; description: string; unit: string; min: number; max: number }> = {
  checkout_hold_minutes: { label: 'Checkout hold', description: 'How long a piece is reserved while the buyer pays.', unit: 'minutes', min: 5, max: 60 },
  payment_grace_minutes: { label: 'Payment grace', description: 'Extra hold while a started payment is still being confirmed.', unit: 'minutes', min: 5, max: 240 },
  offer_expiry_hours: { label: 'Offer expiry', description: 'Time to answer an offer before it expires.', unit: 'hours', min: 1, max: 168 },
  offer_acceptance_hold_minutes: { label: 'Accepted-offer hold', description: 'How long an accepted offer reserves the piece for payment.', unit: 'minutes', min: 10, max: 1440 },
  max_active_reservations_per_buyer: { label: 'Active holds per buyer', description: 'Limit on simultaneous checkouts/holds per buyer.', unit: 'holds', min: 1, max: 50 },
  max_offers_per_thread_per_day: { label: 'Offers per item per day', description: 'Daily limit on a buyer’s offers for one item.', unit: 'offers', min: 1, max: 50 },
  winner_payment_hours: { label: 'Auction winner payment window', description: 'Time the winner has to pay.', unit: 'hours', min: 1, max: 168 },
  second_chance_hours: { label: 'Second-chance reply window', description: 'Time a runner-up has to accept.', unit: 'hours', min: 1, max: 168 },
  dispute_window_days_after_delivery: { label: 'Dispute window', description: 'Days after delivery to report a problem.', unit: 'days', min: 1, max: 60 },
  seller_response_hours: { label: 'Seller dispute response', description: 'Time for a seller to answer a dispute before support reviews it.', unit: 'hours', min: 12, max: 240 },
  dispute_appeal_days: { label: 'Appeal window', description: 'Days after a decision to appeal.', unit: 'days', min: 1, max: 60 },
  delivery_confirmation_reminder_days: { label: 'Delivery confirmation reminder', description: 'Days after a seller-reported delivery before the buyer is reminded.', unit: 'days', min: 1, max: 30 },
  delivery_staff_review_days: { label: 'Delivery staff review', description: 'Days without buyer confirmation before support reviews.', unit: 'days', min: 2, max: 90 },
  payout_release_hours_after_confirmation: { label: 'Payout delay after buyer confirmation', description: 'Hours after the buyer confirms delivery before the payout is released.', unit: 'hours', min: 0, max: 720 },
  payout_release_hours_after_courier_delivery: { label: 'Payout delay after courier delivery', description: 'Hours after a courier-verified delivery (without buyer confirmation).', unit: 'hours', min: 0, max: 720 },
  payout_account_cooling_off_hours: { label: 'New payout account cooling-off', description: 'Hours before a new or changed payout account can receive money.', unit: 'hours', min: 0, max: 336 },
  review_window_days: { label: 'Review window', description: 'Days after delivery to leave a review.', unit: 'days', min: 1, max: 180 },
  commission_bps: { label: 'Commission', description: 'Platform commission on item price (basis points; 100 = 1%). Decision D05 open.', unit: 'bps', min: 0, max: 3000 },
  buyer_fee_bps: { label: 'Buyer fee (percentage)', description: 'Buyer protection fee (basis points). Decision D05 open.', unit: 'bps', min: 0, max: 2000 },
  buyer_fee_flat_minor: { label: 'Buyer fee (flat)', description: 'Flat buyer fee in kobo. Decision D05 open.', unit: 'kobo', min: 0, max: 500_000 },
  max_upload_bytes: { label: 'Max upload size', description: 'Largest accepted photo upload.', unit: 'bytes', min: 1_000_000, max: 20_000_000 },
  max_listing_photos: { label: 'Max photos per listing', description: 'Photo limit per listing.', unit: 'photos', min: 2, max: 20 },
  promotion_payment_window_hours: { label: 'Promotion payment window', description: 'Hours a booked promotion waits for payment before the booking lapses (a later payment is refunded automatically).', unit: 'hours', min: 1, max: 168 },
  promotion_attribution_days: { label: 'Promotion attribution window', description: 'Orders within this many days after a shopper clicks a promotion are shown to the seller as attributed (informational only; never creates fees).', unit: 'days', min: 1, max: 30 },
};
