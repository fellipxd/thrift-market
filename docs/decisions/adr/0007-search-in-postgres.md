# ADR-0007: Search and nearby discovery in PostgreSQL (full-text, trigram, PostGIS)

Status: Accepted, 2026-10-12.

## Decision
- Listing search uses a generated `tsvector` (title A, brand/colour/material B, description C) plus `pg_trgm` on titles
  for typo tolerance; keyset cursor pagination for stable ordering.
- Nearby shops use PostGIS `geography` points at city/area precision with `ST_DWithin`; distances are shown as rounded
  labels; precise coordinates are never sent to clients.
- A dedicated search service is deferred until measured relevance/latency needs it.
