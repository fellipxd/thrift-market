# Brand and UX design specification

**Design status:** proposal extending the supplied four-page concept; not a tested interface or an application implementation. All item names, amounts and photographs in the concept are illustrative. Final name and media rights remain open.

Revision 3: the owner selected an **editorial, high-fashion** style. [Editorial art direction](07-Editorial-Art-Direction.md) governs typography, composition, imagery and component geometry; this document retains the task/state contracts.

## Brand contract

**Position:** editorial fashion marketplace with trustworthy transaction detail. **Voice:** warm, direct and fashion-aware. Say “small mark on left cuff, shown in photo 4,” “delivery to Abuja is available,” and “payment confirmation pending” when each is true. Avoid vague “premium quality,” invented scarcity, unsupported authenticity, “escrow,” and “fully protected” before provider and policy evidence exists.

Photography should show the actual item: front/back, labels, wear and any flaws, without edits that hide condition. Editorial campaign imagery can set mood but cannot replace item evidence. Use owned/licensed imagery. Shop personality belongs in the shop page and seller story; transaction copy must stay consistent and plain.

| Token | Proposal | Tested pair / use |
| --- | --- | --- |
| Canvas | `#F7F3EB` | Warm background. Ink `#171B18` on canvas: **15.73:1** calculated in revision 3. |
| Surface | `#FFFFFF` | Forms and cards. Deep green `#174A3C` on white: **10.09:1** calculated. |
| Primary | `#174A3C` | Buy/confirm/selected navigation, with white text. |
| Text / ink | `#171B18` | Primary content and prices; near-black editorial type. |
| Muted text | `#59665D` | On white: **6.03:1** calculated; still validate every actual component state. |
| Accent | `#A8442F` | Editorial/drop/auction cue on canvas: **5.37:1** calculated. Never a status cue alone. |
| Error | `#A12D2D` | On white: **7.17:1** calculated, paired with explicit text. |
| Border | `#D8DED6` | Visual separation; it is not relied upon as the only control boundary. |

The five ratios above use WCAG relative-luminance arithmetic calculated locally for specified foreground/background pairs. They are **not** a full accessibility audit. Revision 3 uses prominent high-contrast editorial display typography with a legible UI sans at ~16px body, comfortable line spacing, visible focus and 44px preferred touch controls. Flat open composition and fine rules replace rounded-card styling. WCAG 2.2 AA is the launch target; its [text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum) and [pointer-target](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) rules are only part of the audit. Validate keyboard order, semantic labels, live updates, zoom/reflow, reduced motion and error recovery in real screens.

## Navigation and screen inventory

Public mobile navigation: **Discover · Saved · Sell · Inbox · Account**. Auctions appear in Discover and filters. A logged-in seller switches to **My shop** without a separate login. Desktop seller workspace uses a sidebar. This is a testable hypothesis, not a final navigation decision.

| Screen | Leading decision/action | Required states and disclosure |
| --- | --- | --- |
| Discover/search | Search, selected delivery location, categories, followed drops, nearby, auctions. | No location, no results, stale results, sponsored marker, saved state. |
| Browse/filter | Item grid with price, size, condition, location and mode. | Accessible filter sheet, count, clear filters, cursor loading, empty/route-excluded. |
| Nearby shops | Typed city/state first; optional device location. | Permission denied, approximate distance, route coverage, review count, list-first fallback. |
| Shop | Identity/verification explanation, coverage, policies, catalogue, reviews, follow. | Paused/suspended, new shop/no reviews, out-of-route. |
| Item | Actual gallery, flaw photos, measurements, price, seller, coverage and one sale mode. | Sold/reserved, no route, image failure, edited version, fixed/negotiable/auction actions. |
| Seller onboarding | Contact, public shop, approximate location, coverage, verification/payout evidence. | Save progress, pending/rejected/reverification/suspended with reason and appeal route. |
| Listing wizard | Category/version, images, condition/flaws, size, stock, coverage, mode, preview. | Draft, upload progress/failure, missing flaw evidence, restricted goods, published/paused/sold. |
| Chat/offer | Item context, messages and formal term cards. | Sent/delivered, expired/countered/accepted, blocked/report, attachment failure. |
| Auction | Current valid bid, minimum next bid, end rule, shipping estimate, obligation. | Upcoming/live/outbid/extended/closing/ended/winner/pending payment/failure. |
| Checkout | Itemized total, route, reservation clock, policy version, payment continuation. | Expired, stock conflict, provider pending, paid, failed, uncertain/recheck. |
| Order/case | Separate payment, dispatch, transit, receipt, refund and payout history. | Seller-arranged label, courier outage, dispute open, evidence requested, appeal. |
| Review | Eligible order-item and review dimensions. | Ineligible, already reviewed, moderated/replied. |
| Seller workspace | Next actions, inventory, offers, auctions, orders, proceeds, ads. | Empty tasks, delayed metrics, permission denied, payout pending vs settled. |
| Staff queues | Verification, moderation, disputes, finance and audit. | Assigned-only view, two-person exception, conflicting evidence, unavailable provider. |

## Wireframes: hierarchy and key content

These are text wireframes for design review. Boxes indicate hierarchy, not final pixels.

### Discover → item inspection

```text
┌ Discover ───────────────────────────────────┐
│ Search clothes, shoes, bags…                 │
│ Deliver to: Abuja  [Change]  [Near me]      │
│ New drops  Categories  Auctions             │
│ Followed shops  [See all]                   │
│ [Actual photo] [Actual photo]               │
│ Name/price    Name/price                    │
│ Size/grade    Size/grade   [Sponsored]      │
│ Discover  Saved  Sell  Inbox  Account        │
└─────────────────────────────────────────────┘
             ↓ select listing
┌ Item ───────────────────────────────────────┐
│ Gallery: front, back, wear, flaw close-up   │
│ Name · price · declared sale mode            │
│ Size + measurements · condition + flaws     │
│ Seller · identity status · service history  │
│ Deliver to Abuja? cost/estimate/route       │
│ [Buy at listed price] [Make offer]          │
│ Policy/help link · share · save              │
└─────────────────────────────────────────────┘
```

For auction mode, replace both purchase/offer actions with **Review bid and terms**. The auction panel must show minimum valid next bid, current leader state, server-derived close time, extension/outage policy, delivery estimate and payment obligation *before* confirmation. Reconnect obtains an authoritative snapshot; a stale bid is rejected with the current minimum and time. Do not visually imply a bid is a charge.

### Seller listing → publish

```text
Shop status [approved/pending]  →  Add item
Category + attribute schema     →  Upload actual-item photos
Condition + flaw evidence       →  Size/measurements
Unique piece / equivalent units →  Coverage + dispatch method
Fixed / negotiable / auction    →  Review buyer-facing card
[Save draft] [Publish when eligible]
```

Every step can be saved. The review page exposes what buyers see; publication errors point to the exact missing field/photo. A batch may prefill shared data but never merge distinct condition/size pieces. On mobile, preserve an unfinished draft after upload failure. Seller edits to a held/paid item cannot rewrite the buyer's order snapshot.

### Fixed-price reservation and payment

```text
┌ Checkout ───────────────────────────────────┐
│ Item + selected version + actual flaw cue   │
│ Delivery route, source, estimate, address   │
│ Item ₦… | Delivery ₦… | Fees ₦… | Total ₦…  │
│ Protection/return terms [approved policy]  │
│ Hold expires [server clock]                 │
│ [Continue to provider payment]             │
│ Payment pending? [Check order status]       │
└─────────────────────────────────────────────┘
```

The sample ten-minute hold in the source plan is a **draft parameter**. The buyer sees the actual server-backed expiry; a refresh does not invent a new hold. A pending provider result is neither “paid” nor “failed”; the buyer can check status without paying twice. If route/total changes before initiation, show a fresh total and require confirmation.

### Seller workspace → order attention

```text
My shop: name/status  |  Add item
Attention: orders to ship | offers | auction closes | cases
Inventory: item / mode / stock state / next action
Orders: payment confirmed / dispatch due / exception
Money: gross sales / fees / refunds / pending / settled
Promotion: active spend / sponsored label / stop rule
```

Each metric has a definition, time range and “data updated” cue. A seller must not infer cash availability from gross sales or a pending ledger obligation. Staff-only reconciliation detail stays out of seller UI.

## Interaction and component contracts

| Component | Contract |
| --- | --- |
| `ItemCard` | Actual photo, price, size/condition, approximate location, mode and **Sponsored** text when paid. Sold state removes purchase action; skeleton never masquerades as availability. |
| `ConditionDisclosure` | Grade, known flaw/no-known-flaw affirmation, related image anchors and measurement units. Text is readable without image. |
| `SellerTrustPanel` | “Identity verified” explains evidence/process scope; service metrics show sample size and period; neither is sold as an ad benefit. |
| `DeliveryEligibility` | Typed destination, route source, quote age, estimated dispatch and transit separately, unavailable reason, seller-arranged label. |
| `OfferCard` | Amount/currency, actor, expiry, version, status, actions permitted now; accepted amount routes to an exact checkout total. |
| `BidPanel` | Server state, current bid and minimum, end/extension rule, user obligation, explicit confirm; `aria-live` announcements are restrained to avoid noisy rapid updates. |
| `MoneyStatus` | Collection, refund and payout are distinct; “pending” includes next check/action; never labels an initiated provider request “complete.” |
| `CaseTimeline` | Evidence source, actor, timestamp, policy deadline, decision reason and appeal action. Private evidence requires authorised fetch. |
| `Feedback` | Every error names the affected action, whether it succeeded, and a safe next step. Focus moves to useful summary without erasing form data. |

## Journey acceptance and research

1. **Buyer without account:** discover and inspect an item, including flaw evidence and delivery estimate; sign-in occurs only at message/offer/bid/checkout.
2. **Seller onboarding:** create shop and draft, disclose a stained garment with a close-up, set national coverage with exclusions, see verification status.
3. **Negotiation:** buyer offers, seller counters, buyer accepts; exact version/amount appears at checkout. Expired or stock-conflicting acceptance gives a recoverable message.
4. **Auction:** bidder sees commitment and shipping before bid; outbid/extension/close is announced; winner gets deadline and no automatic payment claim.
5. **Fulfilment:** buyer distinguishes integrated tracking from seller-arranged evidence, opens a complaint with the purchased description preserved, and sees refund/payout status accurately.
6. **Return visit:** buyer follows a shop with explicit channel consent, receives at most one eligible notice, and can unsubscribe.

Suggested research: task sessions with 5–8 sellers and 8–12 buyers, recruited across different selling frequency and locations. Record completion, misunderstanding of “identity verified,” protection and payout, condition-photo use, auction obligation and route availability. These sample sizes are practical planning targets; no interviews or usability tests have been run. Test the design at mobile widths and with keyboard/screen-reader users before feature acceptance.
