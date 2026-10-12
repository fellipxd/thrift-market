-- 0002_sandbox_providers.sql
-- State owned by the deterministic sandbox provider adapters (simulating an external provider's records).
-- These tables are not commerce truth; the app only learns outcomes through verify() calls and signed webhooks.

CREATE TABLE sandbox_payments (
  reference      text PRIMARY KEY,
  amount_minor   bigint NOT NULL,
  currency       char(3) NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','succeeded','failed','abandoned')),
  transaction_id text NOT NULL,
  paid_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sandbox_courier_bookings (
  tracking_reference text PRIMARY KEY,
  order_number       text NOT NULL,
  status             text NOT NULL DEFAULT 'booked',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
