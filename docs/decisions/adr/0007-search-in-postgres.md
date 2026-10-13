# ADR-0007: Search and nearby discovery in PostgreSQL (full-text, trigram, PostGIS)

Status: Accepted, 2026-10-12.

## Decision
- Listing search uses a generated `tsvector` (title A, brand/colour/material B, description C) plus `pg_trgm` on titles
  for typo tolerance; keyset cursor pagination for stable ordering.
- Nearby shops use PostGIS `geography` points at city/area precision with `ST_DWithin`; distances are shown as rounded
  labels; precise coordinates are never sent to clients.
- A dedicated search service is deferred until measured relevance/latency needs it.

## Measurements
- 2026-10-13, first local load run at 100,000 listings (`docs/qa/load-testing.md`): relevance-ranked text search costs
  60–130 ms per query because every match is scored; whole-catalogue aggregates (category counts, size facets) were
  moved behind a 60-second public cache and shop cards onto partial indexes (migration 0910). Re-measure with realistic
  titles at staging before adding a candidate cap or a search service.
