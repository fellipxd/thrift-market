# Architecture overview

Logical topology (ADR-0001). PostgreSQL is authoritative; caches, search results, client state and live views are
projections and are revalidated at checkout.

```mermaid
flowchart TD
    U[Buyer / seller / staff browsers] --> W[apps/web — Next.js: pages, server actions, /api/v1, webhooks]
    W --> D[(PostgreSQL 16 + PostGIS)]
    W --> M[Object storage — local disk dev / S3+CDN prod]
    Wk[apps/worker — idempotent scans + outbox dispatch] --> D
    Wk --> P[Provider adapters: payments, courier, messaging]
    W --> P
    P -- signed webhooks --> W
    W -- durable webhook_inbox --> D
```

## Packages and ownership

| Package / module | Owns |
| --- | --- |
| `domain` | Money (kobo), listing publish checklist, stock movement math, offer rules, auction bid/extension rules, state machines, delivery eligibility, reputation scoring, settings defaults. No I/O. |
| `application/core` | Context/actor, authorisation helpers, audit, outbox, idempotency, rate limits, settings, validation, services factory. |
| `application/identity` | Accounts, passwords, sessions, contact verification. |
| `application/inventory` | **The** inventory authority (reserve / release / convert / withdraw / restock). |
| `application/shops`, `catalogue` | Shops, coverage, verification, payout accounts, categories + schema versions, listings, batches, templates. |
| `application/discovery` | Search, home feed, nearby shops, saved/followed reads. |
| `application/checkout`, `payments`, `orders`, `payouts`, `ledger`, `addresses` | Checkout holds, payment attempts, webhook inbox processing, order snapshots, refunds, payouts, double-entry ledger. |
| `application/fulfilment`, `disputes` | Shipments, courier events, delivery confirmation, disputes/returns. |
| `application/messaging`, `offers` | Conversations, messages, offer threads. |
| `application/auctions` | Scheduling, bids, finalisation, winner checkout handoff, second-chance offers. |
| `application/trust`, `growth` | Reviews, reputation, reports/moderation, follows, notifications, consent. |
| `application/ads`, `insights`, `admin` | Promotions, seller metrics, operations console. |
| `providers` | Payment (sandbox, Paystack), courier (sandbox), messaging (sandbox), storage, image processing. |

## Concurrency and money rules

- Lock order: `auctions → offer_threads → inventory_stock → reservations → orders → payment_attempts → payouts`.
- Transactions are short and never call providers. Pattern: record intent → commit → call provider → verify →
  apply in a new guarded transaction. Unknown outcomes become `uncertain` and are reconciled by the worker.
- Every money movement is a balanced, append-only ledger transaction with a unique idempotency key.
- Webhooks: verify signature on the raw body → insert into `webhook_inbox` (unique per provider event) → 200 →
  process inline best-effort → worker retries pending rows.

## State machines (see `packages/domain/src/state-machines.ts`)

```mermaid
stateDiagram-v2
    direction LR
    state "Reservation" as R {
      [*] --> active
      active --> payment_pending: hold expired, payment unresolved
      active --> converted: payment verified
      payment_pending --> converted: late verification succeeded
      active --> released
      active --> expired
      payment_pending --> expired: verified failed / grace passed
    }
```

```mermaid
stateDiagram-v2
    direction LR
    state "Payout" as P {
      [*] --> held: payment captured
      held --> eligible: buyer confirmed / courier verified (+delay) / staff verified, no open dispute
      held --> blocked: dispute opened
      blocked --> held: dispute resolved
      eligible --> processing: release job (verified payout account past cooling-off)
      processing --> paid
      processing --> failed
      failed --> eligible
      paid --> reversed: finance decision only
    }
```

Order (`pending_payment → confirmed → completed | cancelled`), payment (`pending → paid → refund_pending →
partially_refunded | refunded`), fulfilment (`unfulfilled → awaiting_dispatch → dispatched/in_transit → delivered`,
with exceptions/returns), dispute and refund machines are separate columns/tables so one never implies another.

## Time

The server stores UTC; Nigerian users see West Africa Time. Auction validity, hold expiry and deadlines are evaluated
with server time read inside the serialising transaction; client countdowns are corrected by the server time sent with
each snapshot and are informational only.
