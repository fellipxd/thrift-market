# Delivery backlog and implementation handoff

**Status:** phase-0 design output; no application implementation or release. The owner selected **Next.js** and chose to complete planning/design first. All R01–R25 are required before first public launch. Slice boundaries are development milestones, not smaller substitutes for the launch scope.

## Stage gates

| Stage | Exit evidence | Current state |
| --- | --- | --- |
| 0 Discovery/design | Traceable requirements, UX/architecture/contracts, risk/QA plan, decisions for next slice; payment and policy blockers visible. | Packet prepared. User research, owner policies and provider feasibility remain open. |
| 1 Commerce foundation | Seller/catalogue and fixed-price purchase/refund vertical slices; real DB concurrency, object access and provider-event replay evidence. | Not started. |
| 2 Complete launch capabilities | Formal bargaining, scheduled auctions, hybrid delivery, nearby discovery, purchase reviews, follows/consent, ads and seller metrics. Each R01–R25 has evidence. | Not started. |
| 3 Launch hardening | Independent QA/security, approved provider/legal/operating model, accessible journeys, load/restore/reconciliation results and staffed runbooks. | Not started; this is the first public-release gate. |
| 4 Evidence-led growth | Cohort, liquidity, support and measured capacity outcomes guide investment. | Deferred. |

## Dependency-ordered vertical slices

Each slice includes UI, API, persistence, server authorization, negative paths, observability and current documentation. The listed exit checks are planned, not performed. A slice can use deterministic local fixtures, clearly labelled sandbox data and no protection claim until real provider feasibility is established.

| Slice | Objective / in scope | Entry and exclusions | Exit evidence and risks |
| --- | --- | --- | --- |
| **S1 Seller and truthful catalogue** | Next.js buyer public listing/shop views and seller workspace; account/shop capability; category schema; draft/publish listing, actual-item media/flaws/measurements; unique/equivalent stock; mark sold elsewhere; basic staff verification queue. R01–R06, R20, R23–R25 foundation. | Entry: confirm restricted goods, minimum verification and data retention needed for development; choose auth/storage/DB versions. No payment, live bid, ad purchase or protection copy. | Seller publishes a flawed one-piece item and another buyer inspects it; cross-shop edits fail; changed schema preserves old versions; uploads fail safely; keyboard/mobile task passes; web and worker bootstrap independently. Risks: identity evidence handling and media safety. |
| **S2 Scarce fixed-price checkout** | Server reservation, same-seller cart boundary, immutable order snapshot, payment-attempt adapter, verified event inbox/outbox, ledger, reconciliation and refund initiation. R06, R12–R14. | Entry: **D04/D05/D06** provider/legal/fee/release decisions for real integration. A deterministic fake provider may exercise local mechanics but cannot be represented as protected checkout. No auctions or negotiation. | Overlapping DB attempts allocate one last unit; duplicate/late success and uncertain expiry reconcile; exact cost and provider-pending UX; refunds have actual provider status; no cross-object leak. Risk: financial loss and false protection promises. |
| **S3 Delivery and dispute** | Coverage intersection, quote/route, integrated and seller-arranged tracking, evidence, dispute/appeal, payout release request under approved policy. R15–R17, R23. | Entry: **D06/D09/D12**, provider/courier access and support ownership. No seller-only release proof. | Unsupported route blocked before payment; courier outage visible; seller evidence labelled; dispute freezes release; refund/exception audit and replay pass. Risk: delivery proof ambiguity. |
| **S4 Chat and offers** | Scoped item/order messages, report/block, offer/counter/expiry/acceptance and agreed-price checkout. R09–R10. | Entry: S1 inventory and S2 reservation/payment contracts. No informal chat agreement changes payable amount. | Accepted offer and buy-now race allocates once; stale/expired offers reject; abusive attachments/throttling handled; agreed price immutable in checkout. Risk: moderation load. |
| **S5 Scheduled auctions** | Schedule, eligibility, bid sequencing, server time, extension/outage policy, close job, winner payment deadline and recovery. R11. | Entry: S1 stock and S2 payment/hold authority; **D08** auction rules. No proxy, quantity or live video auction. | Bid/close contention selects one winner; duplicate finalizer/restart recovers; outbid/reconnect truthful; failed winner never auto-charges another bidder. Risk: hot-item contention. |
| **S6 Discovery and trust** | Search/nearby, approximate location, follows/consent/drop notices, purchase-derived reviews/reputation and social share links. R07–R08, R18–R19, R21, R24. | Entry: public catalogue, completed-order entitlement, **D10** reputation policy. No private coordinate exposure or imported-contact messaging. | Typed-location works without permission; route filter honest; ineligible review rejected; notice dedup/unsubscribe; low sample counts visible. Risk: empty marketplace and privacy leakage. |
| **S7 Promotion and seller insight** | Approved sponsored placements, billing/eligibility/reporting, defined seller performance and financial states. R20, R22–R23. | Entry: **D05/D10**, paid-service and refund rules. Ads cannot purchase trust. | Sponsored label shown in every placement; sold/suspended stop rule and billing credit tested; reports distinguish gross/refund/fee/pending/settled. Risk: misleading ads/metrics. |
| **S8 Independent hardening** | Cross-slice QA/security, accessibility, load, restore, incident/reconciliation runbooks, operations rehearsal. R25 and all R01–R24. | Entry: all prior functionality, operating owners, provider contracts and policies. No production switch until owner authorizes a concrete release packet. | Revision-bound PASS evidence for each critical gate; material findings closed; reference load and restore measured; protection and legal copy approved. Risk: unresolved provider/operations gate. |

## Risk-based test traceability

The source plan's T01–T18 scenarios are preserved here with a slice owner. Tests should report actual commands, fixtures, overlapping concurrency, revision, environment and observed result later.

| Test | Slices | Required check |
| --- | --- | --- |
| T01 | S2 | 100 simultaneous valid attempts for one unit produce one allocation and no duplicate payable order. |
| T02 | S1/S2/S4/S5 | Offer accept, buy-now and seller stock/mode edit contend through one authority. |
| T03 | S2 | Hold expiry races payment initiation, successful/late/duplicate event and provider uncertainty. |
| T04 | S2/S3 | Forged/out-of-order webhook and repeated refund/payout jobs have one balanced effect. |
| T05 | S5 | Parallel bids and close boundary give one valid winner under server time and extension rule. |
| T06 | S5 | Worker restart around end time recovers close and bidder reconnect state. |
| T07 | S5/S2 | Unpaid winner triggers permitted recovery with no runner-up charge. |
| T08 | All | Cross-object buyer/seller/staff API, media and live subscriptions deny unauthorised access. |
| T09 | S1/S2 | Batch pieces with different size/condition stay distinct through category version changes and purchase. |
| T10 | S1/S3 | Undisclosed-flaw case retains the actual purchased version and evidence. |
| T11 | S3/S6 | Location denied, route excluded and unavailable courier have accurate browse/checkout responses. |
| T12 | S3 | Seller-reported delivery alone cannot release funds; dispute freezes release. |
| T13 | S6/S7 | Nonbuyer review denied; sponsorship does not grant verification/trust. |
| T14 | S6/S7 | Duplicate drop event sends one eligible notice; unsubscribe and sold-ad stop work. |
| T15 | S1/S4 | Malicious/oversized media and abusive message traffic fail safely. |
| T16 | All buyer slices | Keyboard/screen-reader, mobile zoom, slow network and offline/error recovery. |
| T17 | S8 | Sustained/burst load, hot item/auction, queue saturation and provider failure measured. |
| T18 | S8 | Restore backup, replay provider events and reconcile paid-order/ledger obligations. |

## First implementation task packet — ready after a later build instruction

**Target:** S1, seller onboarding, authorized shop access, category schemas, detailed listing/inventory and public item/shop inspection in Next.js. This is the first coherent slice because it establishes truthful item and stock data without depending on unresolved payment settlement. Do not conflate a local mock payment with launch readiness.

**Before coding:** inspect the actual target repository's `AGENTS.md`, git status/diff, architecture and existing tests. If no repository exists, choose a new workspace path and initialize only under the owner's later build instruction. Record exact Next.js/Node/TypeScript versions, deployment target, auth/storage/DB choice and required development secrets policy. Decide S1's restricted category rule and minimum verification flow (D07/D11), or keep affected publication/approval pathways disabled while other S1 work proceeds.

**Implementation contract:**

1. Guest sees published item/shop details with actual condition, size, flaws, location and delivery-coverage summary. Seller creates a draft, uploads validated media, previews and publishes when eligible.
2. One account can become a seller/shop owner and still buy. Every seller mutation requires shop membership and allowed state. Staff verification action is scoped/audited; no raw evidence in public/API responses.
3. Category attribute schema is versioned. Unique stock and equivalent quantities use separate records; same batch does not imply equivalent items. Stock adjustment is durable and cannot go below zero. Mark-sold-elsewhere removes purchase eligibility.
4. Web and worker/domain modules boot independently. Shared business rules do not import Next.js server-only modules. Public cache never becomes inventory truth.
5. Document the API contracts, error cases, data retention decisions and evidence. Use original/licensed assets and clearly label sample seed data.

**Acceptance evidence:** app build and relevant lint/type checks; meaningful unit/integration tests for schema, authorization, publication, stock constraints and upload rejection; two-shop negative access test; mobile/keyboard inspection of listing wizard and buyer item page; independent review appropriate to risk or honest “pending” if unavailable. Report PASS/FAIL/NOT AVAILABLE with revision/environment. No external provider action, deployment, purchase or PR is implicit.

## Final handoff and exact next action

This phase-0 packet is a reviewable specification. The **Next.js choice is confirmed** and the target repository is now `C:\Users\phili\Documents\ChatGPT\thrift store 2`. The owner selected continued design refinement. The protected-money model, fees/refund/release policy, courier and identity contracts, operating owners and final brand remain unresolved. Review D07/D11 for S1 and request the build when ready; no exact activation phrase is required. Obtain qualified provider/legal/operations answers for D04-D06 and D09 before S2/S3 or any protected-checkout claim. User research and independent application QA/security remain pending; the separate planning review addresses specification consistency only.
