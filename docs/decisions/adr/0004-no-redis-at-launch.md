# ADR-0004: No Redis dependency at launch; Postgres for rate limits, outbox and jobs; polling for live updates

Status: Accepted, 2026-10-12.

## Decision
- Rate limiting: fixed-window counters in `rate_limit_counters`.
- Jobs: durable `outbox_events` + scheduled idempotent scans claimed with `FOR UPDATE SKIP LOCKED`.
- Live auction/chat updates: short-interval polling of authoritative snapshots (server time + sequence numbers).
  Clients never decide winners; reconnect = refetch the snapshot.

## Consequences
Fewer moving parts for a small team. Revisit when measured load (T17) shows Postgres contention or when
connection counts for live updates exceed the staging targets; a WebSocket/SSE gateway can then be added as a
projection without changing the authority.
