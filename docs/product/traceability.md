# Requirements traceability (R01–R25)

Status: **Built** = implemented with automated test evidence in this repository; **Partial** = some acceptance
criteria built; **Pending** = not built yet. "Built" is developer-tested only — independent QA/security review is
pending for every row (stage 3 gate).

| ID | Requirement | Status | Where | Evidence |
| --- | --- | --- | --- | --- |
| R01 | Identity and access | Partial | `application/identity`, `core/authz`, per-module ownership checks | identity flows; cross-seller isolation tests (`test/catalogue/listings.test.ts`) |
| R02 | Seller onboarding and verification | Built | `application/shops` (shops, payout-accounts, verification), `/sell/onboarding`, `/sell/settings`, `/sell/verification`, `/admin/verification` | `test/shops/shops.test.ts` |
| R03 | Shop storefront | Built | `getShopStorefront`, `/shops/[slug]` | `test/shops/shops.test.ts`, `e2e/catalogue.spec.ts` |
| R04 | Expandable categories, versioned schemas | Built | `application/catalogue/categories.ts`, `/admin/categories` | schema-version test (T09) |
| R05 | Detailed listings (photos, condition, size, flaws) | Built | `application/catalogue/listings.ts`, `/sell/listings/[id]`, `/items/[id]` | publish-checklist tests, `e2e/catalogue.spec.ts` |
| R06 | Inventory (unique, identical units, batches) | Built | `inventory/authority.ts`, `catalogue/batches.ts` | T01 authority test; batch/restock tests |
| R07 | Browse and search | Built | `application/discovery/search.ts`, `/search` (filters, chips, sort, keyset paging) | `test/discovery/search.test.ts`, `e2e/discovery.spec.ts` |
| R08 | Nearby sellers | Built | `application/discovery/nearby.ts`, `location.ts`, `/nearby` (typed place or device → nearest reference place; rounded distances) | `test/discovery/feeds.test.ts`, `e2e/discovery.spec.ts` |
| R09 | Communication | Pending | slice E | — |
| R10 | Pricing and bargaining | Partial | negotiable mode + private minimum (slice A); offers pending (slice E) | private-minimum privacy test |
| R11 | Auctions | Partial | auction sale mode guard (slice A); auctions pending (slice F) | auction publish guard test |
| R12 | Reservations | Built | inventory authority (foundation); checkout holds with expiry, payment-pending grace, late-payment re-allocation or refund, offer/auction reservation checkout (`application/checkout`) | T01 checkout test (100 concurrent → 1 order); T03 expiry tests (`test/checkout/checkout.test.ts`) |
| R13 | Protected payments | Built (sandbox) | `application/payments` (attempts, verified apply, signed webhook inbox, refunds), `payouts/payouts.ts`, balanced ledger (`ledger/ledger.ts`), `/checkout/*`, `/sandbox/pay/*`, `/api/webhooks/*`, `/admin/finance`. Real provider (Paystack) stays disabled until D04; fees 0 until D05 | T04 webhook/refund idempotency, duplicate payment, amount mismatch (`test/checkout/payments.test.ts`), `e2e/checkout.spec.ts` |
| R14 | Orders and snapshots | Built | listing_versions snapshots (slice A); order item snapshots, policy versions, delivery terms and address snapshot per order (`orders/snapshot.ts`); `/orders`, `/orders/[id]`, `/sell/orders`; seller cancellation before dispatch with full refund | checkout snapshot test; order access isolation test; seller-cancel tests |
| R15 | Delivery coverage | Partial | shop coverage + `quoteDeliveryOptions` + item-page estimate (slice A); “delivers to” search filter (slice B); checkout refuses undeliverable addresses before reserving (slice C); courier booking pending (slice D) | domain eligibility tests; filter-vs-domain matrix test; undeliverable checkout test |
| R16 | Hybrid tracking | Pending | slice D | — |
| R17 | Complaints and returns | Pending | slice D | — |
| R18 | Reviews | Pending | slice G | — |
| R19 | Seller reputation | Partial | domain scoring + storefront display with sample size (slice A); refresh job pending (slice G) | domain reputation test |
| R20 | Seller workspace | Partial | overview, listings, editor, batches, settings (slice A); orders and payouts with gross/refunds/fees/pending/settled shown separately (slice C); insights pending (slice H2) | `e2e/catalogue.spec.ts`, `e2e/checkout.spec.ts` |
| R21 | Favourites and notifications | Partial | save/follow (slice A), `/saved`, `/following` (slice B); notifications/consent pending (slice G) | follow-count test; saved/followed isolation test |
| R22 | Paid promotion | Partial | read side: labelled sponsored placements in home/search/nearby (slice B); campaigns pending (slice H2) | sponsored placement test |
| R23 | Admin operations | Partial | categories, verification queue (slice A); finance console with refund decisions (four-eyes for staff exceptions), unresolved payments, failed webhooks and ledger health (slice C); others pending | verification role tests; refund four-eyes test |
| R24 | Social transition | Partial | share links + QR, templates, batch drops, mark sold elsewhere (slice A) | drop release test |
| R25 | Security, accessibility, scale | Partial | foundation controls; see threat model | T01; upload pipeline |
