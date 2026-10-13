-- Found by the T17 load script at 100,000 listings: shop cards counted and sorted every listing of every shop.
-- Newest public pieces of a shop (shop-card thumbnails, storefront first page).
CREATE INDEX listings_shop_public_newest_idx ON listings (shop_id, published_at DESC, id DESC)
  WHERE status IN ('active','reserved');
-- Count of a shop's buyable fixed-price/negotiable pieces (index-only).
CREATE INDEX listings_shop_active_fixed_idx ON listings (shop_id)
  WHERE status = 'active' AND sale_mode <> 'auction';
-- Auction lists (home live/upcoming, /auctions) filter on sale mode; without this they scan the whole catalogue
-- to find a handful of auction pieces.
CREATE INDEX listings_auction_public_idx ON listings (id)
  WHERE sale_mode = 'auction' AND status IN ('scheduled','active','reserved');
