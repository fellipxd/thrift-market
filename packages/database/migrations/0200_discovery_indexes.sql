-- 0200_discovery_indexes.sql (slice B: discovery)
-- Read-path indexes for browse/search, home feed, saved items and followed shops.
-- All are partial on the public listing statuses so they stay small and match the discovery WHERE clauses.

-- "Newest" browse/search ordering and keyset pagination: ORDER BY coalesce(published_at, created_at) DESC, id DESC.
CREATE INDEX IF NOT EXISTS listings_public_newest_idx
  ON listings ((coalesce(published_at, created_at)) DESC, id DESC)
  WHERE status IN ('active','reserved');

-- Latest public items per shop (followed-shop feeds, shop thumbnails, active counts).
CREATE INDEX IF NOT EXISTS listings_shop_public_recent_idx
  ON listings (shop_id, (coalesce(published_at, created_at)) DESC, id DESC)
  WHERE status IN ('active','reserved');

-- Category browse within public listings.
CREATE INDEX IF NOT EXISTS listings_public_category_idx
  ON listings (category_id, (coalesce(published_at, created_at)) DESC, id DESC)
  WHERE status IN ('active','reserved');

-- Size filter (case-insensitive).
CREATE INDEX IF NOT EXISTS listings_public_size_idx
  ON listings (lower(size_label))
  WHERE status IN ('active','reserved') AND size_label IS NOT NULL;

-- Saved items page: the caller's saves, most recent first, keyset by (created_at, listing_id).
CREATE INDEX IF NOT EXISTS saved_items_user_recent_idx
  ON saved_items (user_id, created_at DESC, listing_id DESC);

-- Followed shops page: the caller's follows, most recent first.
CREATE INDEX IF NOT EXISTS follows_user_recent_idx
  ON follows (user_id, created_at DESC);

-- Live/scheduled auction rails on the home feed.
CREATE INDEX IF NOT EXISTS auctions_listing_status_idx
  ON auctions (status, ends_at)
  WHERE status IN ('scheduled','live');

-- Active sponsored placements by listing/shop (read side of promotions).
CREATE INDEX IF NOT EXISTS ad_campaigns_listing_active_idx
  ON ad_campaigns (listing_id, placement)
  WHERE status = 'active' AND listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ad_campaigns_shop_active_idx
  ON ad_campaigns (shop_id, placement)
  WHERE status = 'active' AND target_kind = 'shop';
