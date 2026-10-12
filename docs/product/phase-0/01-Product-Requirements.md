# Product brief and testable requirements

**Status:** proposed PRD/SRS for owner review, 9 October 2026. IDs R01–R25 map to the supplied product plan. “Must” below describes planned first-public-launch acceptance, not existing software or an approved operating policy.

## Problem, people and value

Nigeria-wide thrift sales are commonly coordinated through social posts and private messages. Item condition, size, availability, negotiated terms, payment and delivery evidence can be scattered. A seller needs a recognizable shop and a manageable inventory record; a buyer needs enough item and seller evidence to make a purchase with a clear after-sale path. The proposed product promise is **find distinctive fashion, understand its condition, and complete the purchase with a clear record**. Any stronger “protected payment” language awaits the actual provider and policy model.

| Group | Current job / pain | Reason to switch (hypothesis to test) |
| --- | --- | --- |
| Small reseller running social drops | Post many unique pieces; answer repeated DMs; mark external sales. | Reusable listings, accurate availability, own shop link and less status chasing. |
| Established reseller | Manage stock, offers, fulfilment and promotion. | Operational view, transaction records and understandable seller proceeds. |
| Wardrobe seller | Sell a few pieces with little setup. | Guided condition disclosure and a credible checkout path. |
| Buyer | Find fit/condition; compare nearby shops; bargain or bid; know delivery and recourse. | Clear item evidence, offer/auction rules, checkout costs and order history. |
| Support/trust/finance staff | Investigate disputes, unsafe listings, uncertain payment and refunds. | Scoped evidence, queues, audit and reconciliation rather than informal intervention. |

**Primary journey:** a seller publishes a genuinely unique piece with photos, flaws and delivery coverage; a buyer finds it, checks measurements and delivery, uses its declared sale mode, pays through a feasible platform flow, tracks the order and can raise a case or review an eligible purchase. A seller's social audience may enter through a shop/item link. Public browsing requires no sign-up; messaging, offers, bids and checkout require an account with verified contact.

## Outcomes and measurement proposals

The first release must demonstrate *correct transactions* before optimizing growth. Candidate measures: provider-confirmed paid orders, completed fulfilments, paid-to-fulfilled conversion, seller time to first sale, listing completion, repeat buyer/seller cohorts, offer acceptance, auction-winner payment, dispatch timeliness, upheld disputes, cancellation reasons and support resolution time. Define denominators and refund handling in the analytics contract; show seller gross sales, fees, refunds, pending proceeds and settled proceeds separately. No baseline, target conversion rate or commercial forecast has been observed.

## Launch boundary

First public launch includes all R01–R25 in bounded form, including **formal bargaining and scheduled auctions**. Proposed limits: domestic NGN only; responsive web; one seller per checkout; same-seller fixed-price cart; accepted offers and auction wins use dedicated checkout; one shop owner per shop; auction for one identified piece; no proxy or live auction. Native apps, international trade, BNPL, transferable wallet, automated private-chat imports, multi-seller cart, quantity auctions and custom ML ranking are later decisions. National eligibility still depends on actual seller and courier coverage for each destination.

## Acceptance matrix

Each row requires positive and negative-path evidence. “Gate” names its earliest implementation slice (S1–S7 in document 04); every row is required by launch. Terms and thresholds that await owner policy are marked **P** and must be fixed before that dependent feature is accepted.

| ID | Verifiable launch acceptance | Failure/abuse path and dependencies | Gate |
| --- | --- | --- | --- |
| R01 Identity/access | One account can buy and become a seller; authenticated mutations and live subscriptions enforce the actor's resource scope. | Guessing another shop/order/message ID yields no data or effect; roles are server-side. Depends on session/MFA policy. | S1 |
| R02 Seller onboarding | Verified contact, identity/business case and payout-beneficiary status are recorded as pending/approved/rejected/reverification/suspended; approval reason and reviewer are auditable. | Unapproved/suspended shop cannot accept new sales; existing orders remain operable. **P:** evidence/retention/provider. | S1 |
| R03 Shop | Unique stable slug shows public name, approximate city/state, coverage, policy, active items, verification explanation and purchase-derived reviews. | Paused shop blocks new allocation but not fulfilment/refunds; private address hidden. | S1 |
| R04 Categories | Admin versions clothes/shoes/bags/accessories schemas; listings retain their schema version and old item/order data remain readable after changes. | Missing required attributes reject publication; schema edit does not rewrite paid history. **P:** restricted goods. | S1 |
| R05 Listings | Required original-item images, condition grade, measurements/size system and explicit known-flaw or no-known-flaw disclosure; visible flaws link to photos. | Missing evidence cannot publish; unsafe upload is rejected/quarantined; no authenticity claim without proof. | S1 |
| R06 Inventory | Unique pieces default to one unit; equivalent quantities require the same buyer-visible attributes; batch can contain distinct pieces; stock never negative. | Concurrent edits/allocation cannot oversell; sold elsewhere ends active availability. | S1–S2 |
| R07 Browse/search | Guests can filter category, size, price, condition, mode, seller and deliverable destination; cursor pagination and stable sort retain filters. | Empty, stale, withdrawn and no-route results have clear states; checkout rechecks truth. | S6 |
| R08 Nearby sellers | Typed city/state works without location permission; optional device location shows approximate distance, coverage and review count. | No public residential coordinates; denied permission falls back to typed location; no route is distinct from no nearby stock. | S6 |
| R09 Conversation | Buyer/seller can message in item/order context, attach permitted images, see unread state and report/block abuse; offer cards keep formal terms. | Cross-conversation reads denied, spam/throttling and attachments checked; reports retain evidence. | S4 |
| R10 Bargaining | Eligible negotiable listing supports offer/counter/reject/withdraw/expiry; one accepted version and agreed total flow to checkout. | Stale, expired or conflicting accept fails; acceptance allocates through Inventory and never edits paid terms. | S4 |
| R11 Auctions | Seller schedules one-piece auction; server validates eligibility, increment, closing time, extension and bid order; one winner gets deadline checkout. | Bid/close race, duplicate finalizer, seller/self bid and failed winner recover without auto-charging runner-up. **P:** auction policy. | S5 |
| R12 Reservations | Cart and pending offer do not reserve; checkout/accepted offer creates bounded durable hold; one authority allocates the last unit. | Expiry waits for uncertain-payment reconciliation; hoarding/rate limits; no double allocation. **P:** hold duration. | S2 |
| R13 Payments | Before pay, itemized NGN total and approved protection/refund terms; verified provider events confirm order; refund and payout obligations reconcile. | Duplicate/late/out-of-order events have one effect; uncertain charge visible; no unsupported protection claim. **P:** provider/legal/fees/release. | S2–S3 |
| R14 Orders | Paid order stores immutable item/media/condition/price/fee/shipping/policy snapshot; payment, order, shipment and payout state remain separate. | Listing edits never alter past purchase; cancelled/refunded history remains auditable. | S2 |
| R15 Coverage | Shop/listing route and current courier/seller option intersect with buyer destination before payment. | Unsupported route blocks checkout with explanation; coverage refresh cannot silently change paid order terms. **P:** actual contracts/routes. | S3 |
| R16 Delivery tracking | Integrated or clearly seller-arranged source, update time, milestones, proof and exception appear in order timeline. | Courier outage and seller-only claims are labelled; no “live GPS” unless actual capability. | S3 |
| R17 Returns/complaints | Buyer can open eligible non-delivery, defect, wrong-item or damage case with evidence and deadline; reviewer records reason, resolution and appeal. | Dispute freezes release per policy; denial/reopen and partial refund are audited. **P:** windows/liability. | S3 |
| R18 Reviews | One eligible review per purchased order-item, dimensions/count, seller reply and reasoned moderation. | Nonbuyer, duplicate, refunded-ineligible and seller self-review rejected; moderation does not silently rewrite score. | S6 |
| R19 Reputation | Verification and service history are shown separately with sample size; recent fulfilment/cancellation/upheld-dispute inputs are explainable. | New seller is not falsely “trusted”; ads cannot buy reputation; appeals supported. **P:** formula/thresholds. | S6 |
| R20 Seller workspace | Own drafts, inventory, offers, auctions, orders, delivery, financial states, ads and defined metrics with next actions. | Cross-shop metrics/orders denied; pending proceeds never labelled settled. | S1–S7 |
| R21 Follows/notices | Buyer can follow/save and choose per-channel new-drop/auction/promotion notices; deduplication and unsubscribe work. | Importing contacts never opts them in; transactional and marketing policy separated. | S6 |
| R22 Promotion | Seller buys an eligible approved placement with clear price/duration, sponsored label, receipt and reporting. | Sold/suspended listings stop promotion with approved credit/refund rule; sponsorship does not change trust. **P:** prices/attribution. | S7 |
| R23 Operations | Scoped admin queues support category, verification, reports, disputes, finance reconciliation and audit search. | Staff cannot self-approve high-impact exceptions or browse all identity evidence by ordinary support role. | S1–S7 |
| R24 Social transition | Shop/item/drop share links and QR, mobile uploads, reusable listing templates, batch drops, mark-sold-elsewhere and owned-content import. | No scraping/private-chat import, unsolicited contact messaging or false stock sync; links show current state. | S1/S6 |
| R25 Security/accessibility/scale | Core journeys pass cross-tenant, concurrency, recovery, upload, keyboard/screen-reader and measured reference-load gates. | Overload degrades safely; errors and recovery are observable; targets are proposed until measured. | S1–S8 |

## Dependency and policy rules

1. Seller identity, shop permissions, category schema and item truth precede checkout.
2. Every allocation path (buy now, accepted offer, auction winner) calls one inventory authority. A listing has exactly one published sale mode; mode edits cannot undermine a hold, accepted offer or live auction.
3. A cart or offer proposal is interest, not stock ownership. The first server-committed valid allocation wins the last item. Provider calls never run while an inventory transaction holds locks.
4. Money is integer minor units plus currency. A provider callback and browser return are separate evidence. Confirmed order, refund, chargeback and payout require reconciled provider state and idempotent processing.
5. Seller-arranged dispatch/delivery is labelled by evidence source. Seller assertion alone cannot prove receipt or release a protected payout.
6. Order snapshots and policy versions stay stable through seller edits, disputes and audits.
7. Real-time, cache and search outputs may lag. Purchase/bid decisions revalidate against server time, stock and delivery authority.
8. Published reviews derive from eligible purchases; verification describes identity/process only; sponsored means paid exposure only.

## Research and policy questions that change acceptance

Task sessions with a small range of buyers and sellers should test a flawed garment listing, nearby discovery without device location, offer negotiation, bid obligation, disputed delivery and seller payout understanding. Record actual task success, hesitation and misunderstanding; the attached concept is not usability evidence. Owner policy work should settle D04–D11 in the decision register. Until then, the acceptance matrix is a design target with explicit blocked paths, not a claim that the marketplace is ready to build end to end.
