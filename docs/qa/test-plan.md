# QA and acceptance test plan

Evidence rule: each result records the revision, environment, command and outcome. Developer-run tests are not
independent QA. Status values: **Pass** (automated test passing at the stated revision), **Partial**, **Pending**.

| Test | Requirements | Scenario | Automated location | Status |
| --- | --- | --- | --- | --- |
| T01 | R06 R12 R13 | 100 concurrent attempts for one unit → one allocation; losers get no payable order | `test/core/inventory-authority.test.ts`, `test/checkout/*` | Pass at authority level (foundation); checkout-level: see slice C |
| T02 | R06 R10 R11 R12 | Offer acceptance vs checkout vs seller stock edits | `test/offers/*` | Pending (slice E) |
| T03 | R12–R14 | Expiry races successful/late/duplicate payment | `test/checkout/*` | Pending (slice C) |
| T04 | R13 R14 R23 | Forged/duplicate/out-of-order webhooks; repeated refund/payout jobs | `test/payments/*` | Pending (slice C) |
| T05 | R11 | Parallel bids, close boundary, anti-sniping, duplicate finalisers | `test/auctions/*` | Pending (slice F) |
| T06 | R11 R25 | Worker restart around end time | `test/auctions/*` | Pending (slice F) |
| T07 | R11 R13 | Winner misses deadline; second chance without surprise charges | `test/auctions/*` | Pending (slice F) |
| T08 | R01–R03 R09 R20 R23 | Cross-object access by buyer/seller/staff | per-slice isolation tests | Partial (catalogue/shops pass; other slices pending) |
| T09 | R04–R06 R14 | Batch with distinct pieces; schema change preserves old listings | `test/catalogue/listings.test.ts` | Pass (listing snapshots; order snapshots pending slice C) |
| T10 | R05 R17 | Undisclosed flaw dispute uses purchased snapshot | `test/disputes/*` | Pending (slice D) |
| T11 | R08 R15 R16 | Nearby with permission denied; excluded destination; unavailable route | `test/discovery/feeds.test.ts`, `test/checkout/*` | Partial (discovery filter matrix and nearby pass; checkout enforcement pending slice C) |
| T12 | R13 R16 R17 | Seller-reported delivery cannot release payout; dispute freezes release | `test/payouts/*`, `test/fulfilment/*` | Pending (slices C, D) |
| T13 | R18 R19 R22 | Non-buyers cannot review; ads grant no trust; low review counts visible | `test/trust/*`, `test/ads/*` | Pending (slices G, H) |
| T14 | R21 R22 R24 | Duplicate drop events do not spam; unsubscribe; sold listings leave promotion | `test/growth/*`, `test/ads/*` | Pending (slices G, H) |
| T15 | R05 R09 R25 | Malicious/oversized uploads, forged MIME, spam | `test/media/*` | Pending |
| T16 | R07–R13 R25 | Keyboard, screen reader, zoom, slow network | Playwright + manual | Pending |
| T17 | R25 | Sustained/burst load, hot item, auction contention | load script | Pending |
| T18 | R13 R14 R25 | Restore backup and reconcile missing provider events | runbook drill | Pending (needs deployment) |

## Proposed staging capacity gate (targets, not measurements)

100,000 active listings; 1,000 concurrent sessions; 200 mixed API req/s for 60 minutes; 5-minute 500 req/s bursts;
1,000 scheduled/live auctions; 50 accepted bids/s across auctions plus a hot-item scenario. Read p95 ≤ 500 ms; mutation
p95 ≤ 1 s excluding provider waits; unexpected errors < 1%; zero oversells, duplicate financial effects or multiple
auction winners.
