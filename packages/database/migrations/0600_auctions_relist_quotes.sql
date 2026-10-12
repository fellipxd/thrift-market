-- 0600_auctions_relist_quotes.sql  (slice F: scheduled auctions)
--
-- 1. Bidder delivery quote snapshots, so a winner is never surprised by changed mandatory delivery fees:
--    each bid records the destination state + the delivery options quoted when it was placed, and the
--    finaliser copies the winning bid's quote onto the auction for the checkout slice.
-- 2. Relisting: a listing may have several auctions over time (failed winner → relist), but at most one
--    open auction. The UNIQUE(listing_id) constraint becomes a partial unique index over open statuses.
-- 3. Second-chance offer lifecycle event kinds and supporting indexes.

ALTER TABLE bids
  ADD COLUMN destination_state text,
  ADD COLUMN delivery_quote    jsonb;

ALTER TABLE auctions
  ADD COLUMN winner_delivery_quote jsonb,
  ADD COLUMN relisted_from_id      uuid REFERENCES auctions(id);

ALTER TABLE auctions DROP CONSTRAINT auctions_listing_id_key;
CREATE UNIQUE INDEX auctions_listing_open_uq ON auctions (listing_id)
  WHERE status IN ('draft','scheduled','live','awaiting_payment');
CREATE INDEX auctions_listing_idx ON auctions (listing_id, created_at DESC);
CREATE INDEX auctions_shop_idx ON auctions (shop_id, created_at DESC);
CREATE INDEX auctions_ended_idx ON auctions (ends_at DESC)
  WHERE status IN ('ended_no_bids','awaiting_payment','paid','failed_unpaid');

ALTER TABLE auction_events DROP CONSTRAINT auction_events_kind_check;
ALTER TABLE auction_events ADD CONSTRAINT auction_events_kind_check CHECK (kind IN (
  'scheduled','started','bid','extended','ended','winner_allocated','payment_received','failed_unpaid',
  'second_chance_offered','second_chance_accepted','second_chance_declined','second_chance_expired',
  'cancelled','relisted'));

CREATE INDEX bids_auction_bidder_idx ON bids (auction_id, bidder_user_id, amount_minor DESC);

CREATE INDEX second_chance_offers_auction_idx ON second_chance_offers (auction_id, created_at DESC);
CREATE INDEX second_chance_offers_bidder_idx ON second_chance_offers (bidder_user_id, status);
CREATE INDEX second_chance_offers_expiry_idx ON second_chance_offers (expires_at) WHERE status = 'pending';
-- A runner-up is offered a second chance at most once per auction.
CREATE UNIQUE INDEX second_chance_offers_bidder_uq ON second_chance_offers (auction_id, bidder_user_id);
