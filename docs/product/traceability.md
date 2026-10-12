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
| R07 | Browse and search | Pending | slice B | — |
| R08 | Nearby sellers | Pending | slice B | — |
| R09 | Communication | Pending | slice E | — |
| R10 | Pricing and bargaining | Partial | negotiable mode + private minimum (slice A); offers pending (slice E) | private-minimum privacy test |
| R11 | Auctions | Partial | auction sale mode guard (slice A); auctions pending (slice F) | auction publish guard test |
| R12 | Reservations | Partial | inventory authority (foundation); checkout pending (slice C) | T01 authority test |
| R13 | Protected payments | Pending | slice C | — |
| R14 | Orders and snapshots | Partial | listing_versions snapshots (slice A); orders pending (slice C) | version tests |
| R15 | Delivery coverage | Partial | shop coverage + `quoteDeliveryOptions` + item-page estimate (slice A); checkout enforcement pending (slice C) | domain eligibility tests |
| R16 | Hybrid tracking | Pending | slice D | — |
| R17 | Complaints and returns | Pending | slice D | — |
| R18 | Reviews | Pending | slice G | — |
| R19 | Seller reputation | Partial | domain scoring + storefront display with sample size (slice A); refresh job pending (slice G) | domain reputation test |
| R20 | Seller workspace | Partial | overview, listings, editor, batches, settings (slice A); orders/payouts/insights pending | `e2e/catalogue.spec.ts` |
| R21 | Favourites and notifications | Partial | save/follow (slice A); notifications/consent pending (slice G) | follow-count concurrency test |
| R22 | Paid promotion | Pending | slice H2 | — |
| R23 | Admin operations | Partial | categories, verification queue (slice A); others pending | verification role tests |
| R24 | Social transition | Partial | share links + QR, templates, batch drops, mark sold elsewhere (slice A) | drop release test |
| R25 | Security, accessibility, scale | Partial | foundation controls; see threat model | T01; upload pipeline |
