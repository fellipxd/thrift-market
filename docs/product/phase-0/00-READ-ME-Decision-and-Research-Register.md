# Thrift marketplace — phase 0 handoff

**Prepared:** 9 October 2026 · **Status:** planning and design, no application implementation · **Market:** Nigeria nationwide · **Currency:** NGN

## Read this first

This packet expands the three supplied planning materials into a build-ready *design proposal*. The owner's current instruction is to finish planning first and **use Next.js when building**. No repository was scaffolded, dependency installed, payment provider contacted, or application feature implemented. A sample name, product count, price, clock, or photograph in the visual concept is illustrative.

| Document | Use |
| --- | --- |
| [01 — Product requirements](01-Product-Requirements.md) | Product brief, journeys, R01–R25 acceptance, boundaries and metrics. |
| [02 — Brand and UX](02-Brand-UX-and-Wireframes.md) | Visual and interaction specifications, screen states, wireframes and research tasks. |
| [03 — Architecture and controls](03-Architecture-Contracts-and-Quality.md) | Next.js architecture, ERD, state/contract outlines, payment feasibility, threat and QA plan. |
| [04 — Delivery backlog](04-Backlog-and-Implementation-Handoff.md) | Ordered slices, gates, first task packet and unresolved decisions. |
| [05 — Journey refinement](05-Journey-States-and-Design-Decisions.md) | Twelve critical journeys, recovery states and owner policy workbook. |
| [06 — Transaction/data refinement](06-Transaction-and-Data-Contracts.md) | Detailed allocation, snapshots, offer rights, auction custody, attempt fences and financial races. |
| [07 — Editorial art direction](07-Editorial-Art-Direction.md) | Owner-selected high-fashion style, expressive typography, composition and photography rules. |
| [08 — Components and responsive specification](08-Editorial-Components-and-Responsive-Spec.md) | Reusable semantic components, interactive states, responsive checkpoints and accessibility contracts. |
| [09 — Editorial screen contracts](09-Editorial-Screen-Contracts.md) | Filter/empty, seller setup/pending, listing creation and current/stale offer screens; planned task acceptance. |

## Authority and evidence ledger

The attached product plan records previous owner answers. I use them as project context, while keeping their recommendations distinct from direct instructions in this chat. The companion “Work / Codex prompt” is source material, not a new authority for this task. The owner confirmed **planning before implementation** in this chat and directly selected **Next.js** for the build.

| Status | Decision or claim | Basis |
| --- | --- | --- |
| **Owner confirmed** | Nigeria-wide eligibility, protected platform checkout, bargaining and auctions in the first public launch, separate fixed/negotiable and auction sale modes, modern thrift boutique, platform and seller delivery. | Supplied plan's decision table; retained as owner decisions in project context. |
| **Owner confirmed now** | Complete planning/design before implementation; build with Next.js later. | Direct chat answer and request, 9 October 2026. |
| **Owner confirmed, revision 3** | Editorial visual style like high fashion. | Direct owner request in this chat, 9 October 2026; replaces the earlier schematic styling. |
| **Design proposal** | TypeScript modular monolith with a Next.js App Router web/API process, PostgreSQL/PostGIS, durable worker, object storage, and optional Redis/realtime process. | Architecture tradeoff in document 03. Next.js is chosen; other components await ADR approval and cost review. |
| **Design proposal** | One shop owner per shop at first release, same-seller checkout, short checkout hold, no guest bid/message/checkout, no cross-seller cart. | Scope reduction that preserves launch functions; exact policies still need owner review. |
| **Unverified hypothesis** | Sellers will switch for easier catalogue, lower DM load, and transaction records; buyers will value condition and purchase evidence. | No user interviews or transaction study supplied. Research tasks are in document 02. |
| **Hard gate** | A provider-backed Nigerian flow can actually support the promised collection, disputed funds, refunds, and payout release. | Public provider material does not establish it. See feasibility table. |

## Decision log

| ID | Decision | Status / next owner action | Affected work |
| --- | --- | --- | --- |
| D01 | Final name, domain, handles, trademark | Open. Shortlist and check before launch artwork. | Brand, legal, URLs. |
| D02 | Team, budget, hosting cost ceiling, demand forecast | Open. Owner supplies a ceiling and operating capacity. | Hosting, vendor choices, targets. |
| D03 | Web framework | **Next.js selected by owner.** Exact supported version, deployment host, authentication, ORM and worker runtime remain open. | Architecture and first build slice. |
| D04 | Protected money flow and provider/legal classification | **Blocked for payment implementation.** Obtain written provider and legal/operations confirmation for this Nigerian marketplace. | R13, R14, payouts, protection copy, launch. |
| D05 | Commission, promotion pricing, fee payer, tax treatment | Open. Model unit economics and approve disclosures before checkout/ads. | R13, R22. |
| D06 | Return, dispute, release, appeal and refund windows | Open. Approve rules with consumer-law review; no invented protection promise. | R13, R17. |
| D07 | Seller identity and payout-beneficiary checks, evidence retention | Open. Select provider/process and access policy. | R02, R23. |
| D08 | Auction increments, extension/outage rules, winner deadline | Open. Policy needed before auction acceptance. | R11. |
| D09 | Courier contracts/coverage and seller-arranged proof | Open. Validate live routes and evidence before checkout integration. | R15–R17. |
| D10 | Reputation thresholds and sponsored-placement policy | Open. Publish criteria and appeals; paid placement never confers trust. | R19, R22. |
| D11 | Restricted category and counterfeit policy | Open. Decide before public listing acceptance. | R04, R05, moderation. |
| D12 | Named support, finance, verification, moderation and incident owners | Open. Set response targets and separation of duties. | Launch readiness. |

Only D03's framework choice changed from the supplied plan. Open decisions do not block writing the first seller/catalogue slice, but D07/D11 affect its production policy. D04/D05/D06/D09 block truthful protected checkout and its launch claims.

## Current source register and feasibility readout

**Accessed 9 October 2026.** These are official primary sources. Their public API descriptions demonstrate possible technical operations, not account approval, local regulatory status, contract terms, route availability, or operational capability. Check again before implementing or signing a provider agreement.

| Source | Current fact used | Design implication / limit |
| --- | --- | --- |
| [Paystack split payments](https://paystack.com/docs/payments/split-payments/) | Splits distribute settlement to a main account and subaccount. | Settlement splitting alone does not establish a delayed, dispute-controlled seller release. |
| [Paystack supported businesses](https://support.paystack.com/en/articles/2129730) and [ineligible businesses](https://support.paystack.com/en/articles/2127042) | The former lists marketplaces and escrow services; the latter lists escrow services as unsupported. | The actual Nigerian business model needs direct written classification and contract review. No “escrow” claim in product copy. |
| [Paystack preauthorisation](https://support.paystack.com/en/articles/10450882) | Published availability is for businesses registered in South Africa and requires enablement. | Do not assume a Nigerian card hold. |
| [Paystack verification](https://paystack.com/docs/payments/verify-payments/) and [webhooks](https://paystack.com/docs/payments/webhooks/) | Server verification and signed webhook events exist; callbacks/retries and pending states require reconciliation. | Verify raw-payload signature, persist events, reconcile before order confirmation. |
| [Paystack refunds](https://paystack.com/docs/payments/refunds/) and [disputes](https://paystack.com/docs/payments/manage-disputes/) | Partial/full refund initiation and asynchronous refund/dispute states are documented. | Refund initiated is not refund complete; operational evidence and chargebacks need workflow design. |
| [Shipbubble rates](https://docs.shipbubble.com/api-reference/rates/request-shipping-rates), [shipment creation](https://docs.shipbubble.com/api-reference/shipments/create-shipment), [tracking](https://docs.shipbubble.com/api-reference/tracking) | Quote, label and tracking interfaces are described. | Per-route price, service, coverage, contract, sandbox and delivery proof remain unverified. |
| [Sendbox tracking](https://docs.sendbox.co/shipping/track-shipment) | Tracking endpoint returns shipment status/events. | An event feed is not live GPS; actual courier availability still needs validation. |
| [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) | Multi-instance cache coordination, deployment versioning, image handling and proxy configuration need explicit setup. | Keep commerce reads and writes against authoritative services; no cache-based stock decisions. |
| [PostGIS ST_DWithin](https://postgis.net/docs/ST_DWithin.html) and [PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html) | Indexed radius predicates and transactional row locks are available. | Use approximate public locations; serialize scarce allocation in the database. Actual correctness needs tests. |
| [W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum) and [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) | WCAG 2.2 AA defines measurable contrast and minimum pointer-target criteria. | Tokens alone do not prove accessible flows. |
| [FCCPC consumer information](https://fccpc.gov.ng/consumers/) and [NDPC](https://ndpc.gov.ng/) | Nigerian consumer and privacy authorities publish applicable guidance. | Obtain qualified review of actual policies, seller identity processing and data retention. This packet is not a legal conclusion. |

### Payment and delivery feasibility gate

| Candidate approach | Public evidence | Decision now |
| --- | --- | --- |
| Immediate seller split | Paystack split docs show shared settlement. | **Unsuitable as proof of protected delayed payout.** Could be revisited only if the approved promise does not require holding seller funds. |
| Card preauthorisation until delivery | Paystack describes it for South African businesses only. | **Do not design it as available for this Nigerian business.** |
| Provider-controlled conditional settlement / approved marketplace model | No applicable Nigerian contract or capability has been supplied. | **Open.** Request written provider response covering who holds funds, when seller is paid, disputes/chargebacks, refunds, fees and business classification. Compare at least one alternative provider if unavailable. |
| Platform-controlled “escrow” in its own ledger | A ledger records obligations but cannot hold regulated funds by itself. | **Rejected without legal/provider model.** Do not market or implement self-declared escrow. |
| Integrated courier | Public API documentation exists. | **Technical candidate only.** Test route coverage, prices, pickup/dropoff, tracking and exceptions under actual access. |
| Seller-arranged delivery | Product requirement and UX pattern. | **Policy needed.** Label evidence source, delivery promise and protection limits; seller self-report cannot alone release funds. |

## Phase-0 progress and limits

**Completed in this packet:** requirements traceability, Next.js architecture proposal, logical data/contract model, UX screen and state specification, risk-based QA and phased implementation packet. I read all three supplied materials and visually inspected the buyer and seller concept pages. I rechecked selected official sources above. Contrast of five proposed colour pairs was calculated locally; see document 02.

**Revision 2 refinement:** this packet now lives in `docs/phase-0` in the owner's chosen `thrift store 2` repository. The owner again chose design refinement before implementation. A separate Avalon planning review identified six transaction omissions; documents 03/06 address them, and a nine-page visual design board is in `outputs/Thrift-Marketplace-Design-Review.pdf`. The planning review is distinct from application QA/security.

**Revision 3 editorial refinement:** the owner requested high-fashion editorial styling. Document 07 governs the prominent serif typography, ivory/ink/green palette, photography, open layouts and task clarity. The current nine-page PDF supersedes the previous visual board and includes original generated concept imagery. All pages received lead render inspection; a separate visual reviewer closed the corrected price/glyph/details on pages 03/06/07. See the output handoff for bounded review and file-check evidence. Next.js remains the eventual build choice; this revision does not implement an application.

**Revision 4 screen/component refinement:** documents 08/09 specify reusable states and proposed responsive rules. A separate four-page editorial flow supplement adds seven screen/state examples for discovery, seller setup, listing creation and formal bargaining. It extends the revision-3 board. Check the latest output handoff for observed visual/file checks and review scope. Implementation and actual interaction/accessibility validation remain pending.

**Pending:** real buyer/seller research, provider/contract/legal confirmation, policy choices, detailed design validation, cost modelling and independent application QA/security review. No user task session, payment API test, courier sandbox test, load test, or accessibility audit occurred. Phase 0 is reviewable, but its money-flow and operating-policy gates remain open.
