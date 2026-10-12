-- Same-seller bag (doc 06 "cart"): an editable interest list. It never holds stock; checkout does.
CREATE TABLE bag_items (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id        uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  quantity          int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 500),
  -- Price when added, only to tell the shopper it changed; checkout always confirms the current price.
  added_price_minor bigint CHECK (added_price_minor > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX bag_items_listing_idx ON bag_items (listing_id);

-- A pending order is the checkout group: every order item carries its own hold, and a group's holds are
-- allocated, expired, released and converted together (all or none).
ALTER TABLE order_items
  ADD COLUMN reservation_id         uuid REFERENCES reservations(id),
  -- Frozen split of the order-level delivery fee, buyer fee and commission (largest remainder by item total),
  -- so a later partial refund uses the terms the buyer accepted.
  ADD COLUMN shipping_share_minor   bigint NOT NULL DEFAULT 0 CHECK (shipping_share_minor >= 0),
  ADD COLUMN buyer_fee_share_minor  bigint NOT NULL DEFAULT 0 CHECK (buyer_fee_share_minor >= 0),
  ADD COLUMN commission_share_minor bigint NOT NULL DEFAULT 0 CHECK (commission_share_minor >= 0);

-- Every existing order has exactly one item, so the order-level values are that item's shares.
UPDATE order_items oi
   SET reservation_id = o.reservation_id,
       shipping_share_minor = o.shipping_minor,
       buyer_fee_share_minor = o.buyer_fee_minor,
       commission_share_minor = o.commission_minor
  FROM orders o
 WHERE o.id = oi.order_id;

CREATE INDEX order_items_reservation_idx ON order_items (reservation_id) WHERE reservation_id IS NOT NULL;

COMMENT ON COLUMN orders.reservation_id IS
  'Set when the order has exactly one hold (single-piece checkout, accepted offer, auction win, second chance); guards one live order per dedicated hold. Multi-piece bag orders leave it NULL. order_items.reservation_id is the hold of each item for every order.';
