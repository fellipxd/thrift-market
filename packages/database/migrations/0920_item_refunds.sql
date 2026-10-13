-- Per-item cancellation and refund of a paid multi-piece order (before dispatch).
ALTER TABLE order_items
  ADD COLUMN cancelled_at  timestamptz,
  ADD COLUMN cancel_reason text,
  ADD COLUMN refund_id     uuid REFERENCES refunds(id);

-- How a refund comes out of each ledger account, frozen when the refund is requested (from the order items'
-- apportioned shares). NULL keeps the older whole/proportional rules.
ALTER TABLE refunds ADD COLUMN allocation jsonb;

ALTER TABLE refunds DROP CONSTRAINT refunds_reason_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_reason_check CHECK (reason IN (
  'buyer_cancelled','seller_cancelled','seller_cancelled_items','dispute_upheld','late_payment_after_release','duplicate_payment','not_delivered','staff_exception',
  'promotion_rejected','promotion_cancelled','promotion_ended_early'));
