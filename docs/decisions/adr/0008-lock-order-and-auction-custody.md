# ADR-0008: Keep the auction-first lock order; auction custody through sale mode and guarded edits

Status: Accepted, 2026-10-12. Relates to phase-0 doc 06 (transaction and data contracts) and ADR-0002.

## Context
Doc 06 proposes the lock order *shop sale gate → checkout/financial roots → stock → auctions → offer threads →
payment/refund/payout attempts* and says a command must never lock an auction first and its stock later. The build
(ADR-0002) uses the opposite relative order for the two scarce roots: *auctions → offer_threads → inventory_stock →
reservations → orders → payment_attempts → payouts*, applied by every write path (bids, closing, second-chance offers,
seller edits, cancellation, moderation, checkout and payment application).

Doc 06 also models auction custody as an explicit inventory allocation created when a scheduled auction is
published, transferred atomically to a winner obligation at close.

## Decision
1. **Keep the auction-first order.** Deadlock freedom comes from every transaction taking the same order, not from
   which root comes first. Reversing it would touch every auction, offer and checkout path for no correctness gain and
   with real regression risk. The rule doc 06 cares about still holds in this form: *a command that touches both
   locks the auction (or offer thread) before the stock, never the other way round.*
2. **Custody is enforced, not modelled as a separate allocation row.**
   - A listing's sale mode is fixed before publication; buy-now checkout only accepts fixed-price/negotiable
     listings and offers only negotiable ones, so no other path can allocate an auction piece.
   - Seller edits (`lockForEdit`) lock the latest auction, then the stock, and refuse stock or mode changes while an
     auction is draft, scheduled, live or awaiting the winner's payment.
   - Closing locks the auction then the stock and reserves the unit for the winner in the same transaction, so the
     piece is never available between close and winner payment; a repeated finaliser returns the existing result.
   - Moderation follows the same order: removing a listing or suspending a shop first stops the listing's or shop's
     open auctions (`stopOpenAuctions`: bidders told, nobody charged, unit withdrawn), then touches stock.
   - Bids require an active shop; a shop with a scheduled or live auction cannot be paused.
3. A winner already allocated keeps their payment window when a listing is removed or a shop suspended; like paid
   orders, existing obligations are handled by support rather than erased.

## Consequences
- Doc 06's lock-order table differs from this codebase; AGENTS.md and ADR-0002 remain the source of truth for code.
- If a future change introduces a path that locks stock and then needs the auction, it must be restructured to take
  the auction first.

## Evidence
`packages/application/test/auctions/auctions.test.ts` — "auction custody under moderation (doc 06)": removing a
listing mid-auction cancels the auction before withdrawing stock (no stuck closing job, no further bids); suspending
a shop stops its auctions; paused/suspended shops take no bids; a shop with a live auction can't be paused. Existing
T05–T07 tests cover bid/close contention, finaliser restarts and winner non-payment.
