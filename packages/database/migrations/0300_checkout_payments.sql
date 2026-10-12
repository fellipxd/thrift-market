-- 0300_checkout_payments.sql (slice C: checkout, payments, orders, payouts)

-- A verified success for an order that was already paid by another attempt: money arrived, it is refunded,
-- and it must never count as a second payment (payment_attempts_one_success_per_order stays intact).
ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN ('initiated','pending','uncertain','succeeded','failed','abandoned','duplicate'));

-- Payout transfer retries.
ALTER TABLE payouts ADD COLUMN attempts int NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN last_error text;
ALTER TABLE payouts ADD COLUMN processing_started_at timestamptz;
CREATE INDEX payouts_processing_idx ON payouts (processing_started_at) WHERE status = 'processing';
CREATE INDEX payouts_held_idx ON payouts (order_id) WHERE status IN ('held','blocked');

-- Refund processing queue and per-attempt lookups.
CREATE INDEX refunds_approved_idx ON refunds (updated_at) WHERE status IN ('approved','processing');
CREATE INDEX refunds_payment_attempt_idx ON refunds (payment_attempt_id);

-- Order lists and seller dashboards.
CREATE INDEX orders_shop_status_idx ON orders (shop_id, status, fulfilment_status, created_at DESC);
CREATE INDEX orders_pending_reservation_idx ON orders (reservation_id) WHERE status = 'pending_payment';

-- Shipments: dispatch deadline scans.
CREATE INDEX shipments_dispatch_due_idx ON shipments (dispatch_by) WHERE status = 'pending';

-- Refund provider retries.
ALTER TABLE refunds ADD COLUMN attempts int NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN last_error text;
