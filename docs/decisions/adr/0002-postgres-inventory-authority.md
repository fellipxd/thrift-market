# ADR-0002: PostgreSQL is the authority for stock, holds, bids and money records

Status: Accepted, 2026-10-12.

## Decision
- `inventory_stock` has one row per listing with CHECK constraints
  `total = available + reserved + sold + withdrawn` and all quantities ≥ 0.
- Every allocation path calls `application/src/inventory/authority.ts` (`reserveStock`, `releaseReservation`,
  `convertReservation`, `withdrawStock`, `restock`) which locks the stock row `FOR UPDATE`.
- Global lock order: auctions → offer_threads → inventory_stock → reservations → orders → payment_attempts → payouts.
- Short transactions with `lock_timeout`; provider calls happen after commit; results are applied in a new
  transaction with status guards.
- Reservation timers never free stock while a payment may have succeeded: unresolved attempts are verified with the
  provider; uncertain holds move to `payment_pending` with a grace period; late successes either reallocate the same
  unit if still free or trigger an automatic refund. A unit is never assigned to a second paid order.
- Ledger: append-only, double-entry, a deferred constraint trigger rejects unbalanced transactions.

## Evidence
`packages/application/test/core/inventory-authority.test.ts` — 100 concurrent reservations for one piece produce
exactly one hold (T01 at the authority level).
