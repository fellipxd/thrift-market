# Decision log

Status key: **Confirmed** = owner decision. **Adopted default** = engineering recommendation implemented as a
configurable default so work can proceed; it is *not* owner approval and can be changed without code rewrites.
**Open** = needs an owner/provider/legal answer before the dependent capability can go live.

## Confirmed owner decisions

| ID | Decision | How the build honours it |
| --- | --- | --- |
| C1 | First market: Nigeria nationwide | NGN only; 36 states + FCT; coverage per shop/listing; delivery eligibility per destination. |
| C2 | Protected platform checkout | Buyers pay the platform's payment provider; payouts are held until delivery is confirmed/verified and no dispute is open. No direct seller transfers. |
| C3 | Bargaining and auctions in first public launch | Offers (R10) and scheduled auctions (R11) are built as launch features, not deferred. |
| C4 | Separate sale modes | `listings.sale_mode` is one of fixed / negotiable / auction, declared before publication. Fixed-price checkout never converts into an auction. |
| C5 | Brand direction: modern thrift boutique | Tokens from the concept (cream `#F7F3EB`, deep green `#174A3C`, accent `#A8442F`), Inter UI + editorial serif headings. |
| C6 | Delivery: platform and seller options | Integrated courier adapter (sandbox now) plus labelled seller-arranged delivery and pickup. |
| C7 | 2026-10-12: owner instruction "review, understand and then proceed to build" | Supersedes the plan's earlier "planning only" state for **local implementation**. It does not authorise production deployment, provider onboarding, spending, or external messaging (plan §1, prompt §"Conditional instructions"). |
| C8 | 2026-10-12: stop work when the weekly/hourly usage quota is exhausted (no paid overage) | Work is committed and pushed in slices so progress survives an abrupt stop. |

## Adopted defaults (recommendations, configurable)

| ID | Default | Where to change |
| --- | --- | --- |
| A1 | Stack: TypeScript, Next.js 16 App Router, PostgreSQL 16 + PostGIS, modular monolith with a separate worker (ADR-0001) | ADRs |
| A2 | Checkout hold 10 min; payment grace 30 min; offer expiry 24 h; accepted-offer hold 60 min; winner payment 24 h | `platform_settings` (admin → Policy settings) |
| A3 | Anti-sniping: bid in final 2 min extends to 2 min after the bid, max 10 min total | `auctions` columns per auction (defaults in domain) |
| A4 | Condition grades: unworn / excellent used / good used / visibly worn; flaws need photo evidence | `packages/domain/src/listing.ts` |
| A5 | Commission, buyer fee: **0** until D05 | `platform_settings.commission_bps`, `buyer_fee_bps`, `buyer_fee_flat_minor` |
| A6 | Payout eligibility: buyer confirmation, or courier-verified delivery + 72 h, or staff verification; seller-reported delivery alone never releases | `platform_settings` + `payouts` module |
| A7 | Reputation: Bayesian rating + dispatch timeliness − cancellations − upheld disputes; tiers new/established/trusted | `packages/domain/src/reputation.ts` (D10 calibration pending) |
| A8 | Sandbox providers for payments, courier and messaging, visibly labelled | `PAYMENT_PROVIDER`, `COURIER_PROVIDER` env |
| A9 | One shop per seller, one owner (membership table ready for staff later) | schema `shops.owner_user_id UNIQUE`, `shop_members` |
| A10 | Ad packages with draft sandbox prices | `ad_packages` (admin) — D05/D10 |
| A11 | Intimate wear/swimwear category marked `restricted` (extra policy needed) | `categories.restricted` — D11 |

## Open decisions (block go-live of the dependent capability, not development)

| ID | Open decision | Current handling in code | Blocks |
| --- | --- | --- | --- |
| D01 | Final brand name/domain | "Thrift Market" working name in UI copy and README | Public launch artwork |
| D02 | Budget, team, forecast load | Proposed staging gate in docs/qa | Capacity purchase |
| D03 | Hosting, exact versions | Versions pinned in package.json; self-host notes in docs/operations | Deployment |
| D04 | Protected-money provider & legal model | Paystack adapter implemented but **disabled**; sandbox adapter default. Splits ≠ escrow; escrow guidance conflicts (plan S7–S12). | Real payments |
| D05 | Fees and unit economics | All fees 0, itemised if configured | Monetisation |
| D06 | Returns/disputes/release windows | Draft settings (3-day dispute window, 48 h seller response) | Protection promise |
| D07 | Seller verification evidence/provider | Manual staff review of restricted evidence; badge text states the check and date | Verified badge at scale |
| D08 | Auction policy details (eligibility, sanctions) | Draft rules shown before bidding; strikes counted on non-payment | Auction terms |
| D09 | Courier contracts & qualifying evidence | Sandbox courier; `courier_routes` table drives coverage | Integrated delivery |
| D10 | Reputation thresholds & ad policy | Draft thresholds; ads never affect trust | Trusted badge, ad pricing |
| D11 | Category safety (intimates, restricted goods) | Restricted flag; prohibited-goods reporting | Restricted categories |
| D12 | Operational accountability | Role-separated console (support, trust & safety, finance, admin) | Staffed operations |
