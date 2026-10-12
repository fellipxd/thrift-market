-- Slice H2: paid promotion lifecycle and seller insights.

-- Refunds can now belong to a promotion instead of an order (money still only moves through the payments module).
ALTER TABLE refunds ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE refunds ADD COLUMN ad_campaign_id uuid REFERENCES ad_campaigns(id);
ALTER TABLE refunds ADD CONSTRAINT refunds_one_subject CHECK ((order_id IS NULL) <> (ad_campaign_id IS NULL));
ALTER TABLE refunds DROP CONSTRAINT refunds_reason_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_reason_check CHECK (reason IN (
  'buyer_cancelled','seller_cancelled','dispute_upheld','late_payment_after_release','duplicate_payment','not_delivered','staff_exception',
  'promotion_rejected','promotion_cancelled','promotion_ended_early'));
CREATE INDEX refunds_ad_campaign_idx ON refunds (ad_campaign_id) WHERE ad_campaign_id IS NOT NULL;

-- Campaign bookkeeping: who booked it, when it actually stopped (scheduled end stays in ends_at).
ALTER TABLE ad_campaigns ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE ad_campaigns ADD COLUMN ended_at timestamptz;
ALTER TABLE ad_campaigns ADD COLUMN reviewed_at timestamptz;
-- Counters live in ad_daily_stats (no hot-row updates on the campaign for every impression).
ALTER TABLE ad_campaigns DROP COLUMN impressions;
ALTER TABLE ad_campaigns DROP COLUMN clicks;
CREATE INDEX ad_campaigns_review_idx ON ad_campaigns (paid_at) WHERE status = 'pending_review';
CREATE INDEX ad_campaigns_due_idx ON ad_campaigns (starts_at, ends_at) WHERE status IN ('scheduled','active');
-- One open campaign per target and placement (no paying twice for the same slot by accident).
CREATE UNIQUE INDEX ad_campaigns_one_open_listing_uq ON ad_campaigns (listing_id, placement)
  WHERE target_kind = 'listing' AND status IN ('awaiting_payment','pending_review','scheduled','active','paused');
CREATE UNIQUE INDEX ad_campaigns_one_open_shop_uq ON ad_campaigns (shop_id, placement)
  WHERE target_kind = 'shop' AND status IN ('awaiting_payment','pending_review','scheduled','active','paused');

-- Impressions and clicks: deduplicated per viewer per campaign per day (viewer hash never holds a raw IP).
CREATE TABLE ad_impression_dedupe (
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  viewer_hash text NOT NULL,
  day         date NOT NULL,
  PRIMARY KEY (campaign_id, viewer_hash, day)
);

CREATE TABLE ad_clicks (
  id          bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id),
  viewer_hash text NOT NULL,
  day         date NOT NULL,
  clicked_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, viewer_hash, day)
);
CREATE INDEX ad_clicks_user_idx ON ad_clicks (user_id, clicked_at) WHERE user_id IS NOT NULL;
