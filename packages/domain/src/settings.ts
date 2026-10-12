/**
 * Draft operational parameters. All are stored in platform_settings and editable by admins;
 * these defaults come from the product plan and are not final policy decisions.
 */
export const DEFAULT_SETTINGS = {
  checkout_hold_minutes: 10,
  payment_grace_minutes: 30,
  offer_expiry_hours: 24,
  offer_acceptance_hold_minutes: 60,
  max_active_reservations_per_buyer: 5,
  max_bag_items: 20,
  max_offers_per_thread_per_day: 6,
  winner_payment_hours: 24,
  second_chance_hours: 24,
  dispute_window_days_after_delivery: 3,
  seller_response_hours: 48,
  dispute_appeal_days: 7,
  delivery_confirmation_reminder_days: 3,
  delivery_staff_review_days: 10,
  payout_release_hours_after_confirmation: 0,
  payout_release_hours_after_courier_delivery: 72,
  payout_account_cooling_off_hours: 24,
  review_window_days: 30,
  commission_bps: 0,
  buyer_fee_bps: 0,
  buyer_fee_flat_minor: 0,
  max_upload_bytes: 8 * 1024 * 1024,
  max_listing_photos: 12,
  promotion_payment_window_hours: 24,
  promotion_attribution_days: 7,
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = { -readonly [K in SettingKey]: number };
