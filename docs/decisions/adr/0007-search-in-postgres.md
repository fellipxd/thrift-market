# ADR-0007: Search and nearby discovery in PostgreSQL (full-text, trigram, PostGIS)

Status: Accepted, 2026-10-12.

## Decision
- Listing search uses a generated `tsvector` (title A, brand/colour/material B, description C) plus `pg_trgm` on titles
  for typo tolerance; keyset cursor pagination for stable ordering.
- Nearby shops use PostGIS `geography` points at city/area precision with `ST_DWithin`; distances are shown as rounded
  labels; precise coordinates are never sent to clients.
- Text matching is two-stage: exact full-text first (index-driven); only when that finds less than a page does search
  widen to spelling-corrected words (edit distance against the words used in public listings, cached 10 minutes) and
  trigram title similarity, and the page says "Including results for …". Later pages keep their first page's mode.
- Price sorts read fixed-price pieces in price order from partial indexes and merge in auction pieces ordered by their
  current bid, instead of pricing every match (migration 0940).
- A dedicated search service is deferred until measured relevance/latency needs it.

## Measurements
- 2026-10-13, first local load run at 100,000 listings (`docs/qa/load-testing.md`): relevance-ranked text search costs
  60–130 ms per query because every match is scored; whole-catalogue aggregates (category counts, size facets) were
  moved behind a 60-second public cache and shop cards onto partial indexes (migration 0910). Re-measure with realistic
  titles at staging before adding a candidate cap or a search service.
- 2026-10-13, after the two-stage matching, price-sort indexes and the sale-mode-gated auction join (in-process,
  `load search`, 100,000 listings, p50 / p95): price-sorted category 200–250 / 320–360 ms → 7 / 11 ms; price-sorted
  whole catalogue 815 / 1,017 ms → 6 / 10 ms; one common word matching ~6,300 pieces 110 / 142 → 72 / 90 ms; typo
  "shrit" (no results before) → corrected to "shirt", 77 / 91 ms. The remaining text cost is ranking every match;
  re-measure with `load search` on staging data before a candidate cap or a search service.
