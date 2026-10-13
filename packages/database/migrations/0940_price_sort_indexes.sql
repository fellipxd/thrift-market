-- Price-sorted browsing (search sort price_asc / price_desc) read every public piece of a category, priced each one
-- through the latest-auction join and sorted them all: ~200 ms per large category and ~800 ms across the whole
-- catalogue at 100,000 listings. Fixed-price and negotiable pieces are now read in price order straight from these
-- indexes (auction pieces, whose price is the current bid, are ordered separately and merged; discovery/search.ts).
CREATE INDEX listings_public_fixed_price_idx ON listings ((coalesce(price_minor, 0)), id)
  WHERE status IN ('active','reserved') AND sale_mode <> 'auction';
CREATE INDEX listings_category_fixed_price_idx ON listings (category_id, (coalesce(price_minor, 0)), id)
  WHERE status IN ('active','reserved') AND sale_mode <> 'auction';
