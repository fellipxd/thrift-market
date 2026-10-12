-- 0100_catalogue_drafts_and_drops.sql (slice A: shops, catalogue, listings)
--
-- 1. A draft needs somewhere to keep the quantity the seller intends to publish. Stock rows are created
--    only by the inventory authority at publish time (initialiseStock), so drafts cannot use inventory_stock.
--    After publishing, inventory_stock is the only authority; this column is never read for availability.
ALTER TABLE listings
  ADD COLUMN initial_quantity int NOT NULL DEFAULT 1 CHECK (initial_quantity BETWEEN 1 AND 500);

-- 2. The scheduled-drop release task scans for due, unannounced drops and their scheduled listings.
CREATE INDEX batches_drop_due_idx ON batches (drop_at) WHERE drop_at IS NOT NULL AND drop_announced_at IS NULL;
CREATE INDEX listings_scheduled_idx ON listings (batch_id) WHERE status = 'scheduled';

-- 3. Verification queue and payout-account lookups.
CREATE INDEX verification_cases_shop_idx ON verification_cases (shop_id, submitted_at DESC);
CREATE INDEX payout_accounts_shop_idx ON payout_accounts (shop_id, created_at DESC);
CREATE INDEX listing_templates_shop_idx ON listing_templates (shop_id, created_at DESC);
