# Editorial components and responsive specification

Revision 4, 9 October 2026. Planning and design contract for the later Next.js build. The owner selected **editorial, high-fashion** styling; the numeric layout rules and component behaviors below are design proposals. They preserve the journeys and truthful transaction states in [02](02-Brand-UX-and-Wireframes.md), [05](05-Journey-States-and-Design-Decisions.md) and the visual direction in [07](07-Editorial-Art-Direction.md).

This document specifies expected behavior. Static boards demonstrate composition only. No interactive application, user testing, keyboard audit or assistive-technology test is evidenced here. Final brand, licensed webfonts, payment model, fees, hold durations, auction rules and identity policy remain unresolved decisions.

## Repeated decisions and usage boundaries

Use one masthead/navigation family, one field/error family, one money formatter, one status vocabulary and one action hierarchy across buyer, seller and staff surfaces. Public discovery expresses the strongest editorial composition; financial and operational screens retain its typography, paper, rules and measured spacing. Reuse these semantic patterns without imposing a generic card around every piece of content.

Campaign composition can vary. Price, condition, recipient permissions, delivery disclosure and authoritative status must keep the same meaning wherever they appear. Role-specific controls remain subject to the established access scope; a visually available action does not establish permission.

## Tokens

The following colours and geometry preserve revision 3. Existing contrast calculations apply only to the exact pairs documented in 02; new assembled states require validation.

| Semantic role | Value | Use |
| --- | --- | --- |
| Paper | `#F7F3EB` | Main editorial canvas. |
| Surface | `#FFFFFF` | Input/evidence areas when extra separation is useful. |
| Ink | `#171B18` | Primary text, headlines, prices and strong outlines. |
| Primary | `#174A3C` | Main action and selected state; white label on filled action. |
| Muted text | `#59665D` | Secondary metadata that remains readable. |
| Editorial accent | `#A8442F` | Occasional drop/auction emphasis; never the sole status signal. |
| Error | `#A12D2D` | Error text and indicator, with an explicit explanation. |
| Rule | `#D8DED6` | Dividers; controls also need an adequate visible boundary. |
| Geometry | `0–2px` radius; flat surfaces | Straight image/control edges, fine rules, no decorative shadows. |

Type and spacing values refine the established proportions and remain proposals for actual UI testing.

| Role | Proposed scale / behavior |
| --- | --- |
| Masthead / display | Licensed Bodoni-style high-contrast serif; home display 72–112px at desktop, 44–64px on normal mobile; short meaningful line breaks. At 320px or enlarged text, allow 36–44px and natural wrapping. |
| Screen heading | Serif 32–48px; line height 1.12–1.2; never place running text over a busy photograph. |
| Item title | Serif 20–28px; wrap complete meaningful words. Catalogue titles may take multiple lines instead of hiding identifying text. |
| Body / controls | Neutral or humanist sans, 16px minimum default, line height 1.45–1.6; inherit user text enlargement. |
| Metadata | Sans 14–16px; tracked uppercase reserved for short labels, with no letter spacing added to paragraphs or amounts. |
| Money | Sans with verified `₦` and currency/number glyphs, tabular figures where supported; 16–20px catalogue, 24–36px detail, up to 48px focal amount. |
| Space | 4, 8, 12, 16, 24, 32, 48, 64, 96px; normal related-field gap 16px, section gap 32–48px, major editorial gap 64–96px at desktop. |
| Control / focus | Prefer at least 44px actionable height/area; visible 2px outline with 2px offset, using an adequately contrasting token against the actual surface. Never clip the outline. |

Font loading must preserve readable fallback text and avoid hiding amounts. Local Bodoni MT/Segoe UI rendering is reference evidence only; do not distribute their files without licensing evidence. The shared money formatter must show the correct currency and amount in cards, offers, checkout, auction and proceeds. Verify naira at regular/bold sizes and with webfont load failure. A missing glyph must fall back to a supported font or an explicit `NGN` amount, never a square placeholder.

## Responsive contract

These are proposed layout checkpoints, not device-specific promises or measured application results. Use available space and content fit between checkpoints; do not choose layout solely from a device label. All sizes refer to CSS pixels.

| Checkpoint | Expected layout |
| --- | --- |
| 320px reflow | One catalogue column when two cannot fit enlarged title, price and condition. Stack transaction details and actions. Reflow navigation labels and filters; no page-level horizontal scroll or essential dragging. Permit horizontal scroll only for content that intrinsically needs two dimensions, with a readable alternative for seller tables. |
| 360px | 16px outer gutter and 16px catalogue gap; normally two item columns, with complete prices and readable condition/size. Search and destination precede campaign; keep campaign bounded and reveal a product preview promptly. Product details and forms use one column. |
| 768px | 32px outer gutter; proposed three catalogue columns when metadata fits, otherwise two. Product image/details can sit side by side only when reading/action space remains adequate. Filters may use a drawer; operational forms stay a clear reading width. |
| 1200px and above | 48–64px outer gutters, approximately 1280px maximum content width; twelve-column editorial grid, normally four catalogue columns. Asymmetric home composition has one focal image. Persistent filter rail and seller navigation may appear if the remaining content fits. |

At every width, long names, currency amounts, field errors and translated labels can wrap without overlap. Preserve logical reading order when visual columns rearrange. Seller tables become labelled records on narrow screens; retain amount definitions, status and next action. Sticky purchase/footer actions are optional and must not cover content, validation errors, safe-area space, keyboard focus or the on-screen keyboard. Test text enlargement and zoom/reflow before implementation acceptance.

## Navigation and common components

| Component | Required content and behavior |
| --- | --- |
| `EditorialHeader` | Working masthead links home; desktop destinations expose Discover, Saved, Sell/My shop, Inbox and Account. Shops and Auctions can be secondary discovery destinations. Search and selected destination stay reachable. Active destination uses text/semantics as well as colour. |
| `MobileNavigation` | Preserve Discover · Saved · Sell · Inbox · Account as the proposed five-destination family in 02. A buyer with a shop reaches it through Sell/My shop without a second login. Avoid a separate competing navigation system on item or transaction screens. Board shorthand such as “Menu / Bag” is not a final route contract. |
| `SearchDestination` | Labelled search plus selected city/state, Change and optional Near me. Typed destination works after location permission denial. Proximity never substitutes for route eligibility. |
| `ItemCard` | Actual-piece image; complete name; price/currency; size/condition; approximate location; sale mode; Sponsored text when paid. Auction amount must say whether it is the current bid or starting/minimum amount. Availability is explicit; a saved/cart state never reserves stock. |
| `ItemGallery` | Full item views, relevant labels/lining/soles and separate flaw close-ups. Labelled previous/next and thumbnail controls, informative alternatives and failure placeholders. Campaign crops never replace condition evidence. Gallery can open a larger view without making essential evidence depend on dragging. |
| `ConditionDisclosure` | Declared grade, known flaw or explicit no-known-flaw affirmation, photo references and measurements with units. Preserve the purchased snapshot after seller edits. Text carries the disclosure even if images fail. |
| `StatusNotice` | Plain status, affected object/action, whether it succeeded, safe next step and last authoritative update where relevant. Distinguish pending from failure and payment from dispatch/refund/payout. |
| `FormField` / `ErrorSummary` | Persistent label, optional instructions, unit/format, value, linked error and required indication. Error summary links to affected fields and receives useful focus after a failed submission; entered data survives. |
| `Action` | One filled primary action per decision region; outlined secondary action; text link for navigation. Button for commands, link for destinations. Label names the task and changes meaningfully while busy. Destructive/policy-sensitive commands use their existing confirmation contract. |

The header family must expose the same underlying destinations across sizes. If mobile uses a bottom bar, reserve its space and retain an accessible menu for overflow. A checkout can simplify its visual header while keeping a clear return/order/help path; it must not erase the buyer's context or imply a new account/session.

## State variants

| State | Shared visual and interaction contract |
| --- | --- |
| Default / hover | Readable label and boundary. Links gain an underline; button/image hover can subtly emphasize the existing boundary or label. Do not reveal essential actions only on hover. |
| Focus | Persistent visible outline, meaningful focus order and accessible name. Focus cannot be obscured by a drawer, sticky rail or clipped container. |
| Selected / active | Explicit selected label/check and appropriate semantics in addition to colour. Filter selection remains visible when the drawer closes. |
| Loading / submitting | Stable image/content dimensions; text describes what is loading. Prevent duplicate commands while retaining current values. Do not display invented stock, verification, price or payment success in a skeleton. |
| Disabled / unavailable | Explain the prerequisite or state nearby. Avoid opacity alone. A pending verification may block publication while allowing draft saving and access to existing orders/support. |
| Empty | State why the set is empty, show relevant constraints and provide a useful next action. No results differs from a fetch failure, route exclusion and a seller's first listing. |
| Error / interrupted | State the failed task, whether completion is known, and retry/recovery. Keep field/message/upload references and original payment attempt. Retrying upload/send must not imply a duplicate succeeded. |
| Conflict / stale | Show the authoritative changed state/version, preserve attempted input and history, and offer an explicit fresh action. Never silently overwrite a draft, accept a counteroffer, increase a bid or change a total. |

Status cannot rely on colour alone. Announce important results without stealing focus on every background update. Auction announcements prioritize the user's bid accepted/rejected, outbid and close changes; a countdown is not read every second. Respect reduced motion; animation conveys no unique information.

## Task components and representative states

| Component / example | Contract |
| --- | --- |
| `FilterPanel` / zero matches | Category, size, condition, sale mode, destination and sort have labels; result count reflects current authoritative response. Apply and Clear filters preserve query context. Empty copy names the active constraints and lets the buyer edit or clear them; route exclusion is explained separately. |
| `SellerSetupStatus` / pending evidence | Show saved progress, public-preview/private-evidence distinction, current status, specific missing/rejected requirement and allowed next actions. Pending never displays approved/verified. Suspension preserves existing fulfilment/case access within permission scope. |
| `ListingComposer` / failed flaw upload | Versioned category fields, original images, condition/measurements, stock model, route, mode and buyer preview. Failed upload retains selected media/text and offers retry. Publish names the exact missing field/photo; category changes require confirmation before discarding incompatible data. |
| `Conversation` / stale formal offer | Item/version context, own message draft, sender/status and formal term history. Free text does not change payable price. Attachment failure preserves the conversation and draft; block/report keeps existing order evidence and support access. |
| `OfferCard` / recipient acceptance | Amount/currency, actor, named intended recipient, version, expiry and current status. Only the authorized recipient can accept that exact version; other viewers receive explanatory state without an acceptance command. Countering creates a new version and preserves history. |
| `CheckoutSummary` / changed quote | Accepted/listed item amount, delivery, individually named fees, exact total, item/condition snapshot, route and terms before payment. Changed total requires explicit confirmation before initiation. An accepted `₦7,800` item plus `₦2,000` delivery and an illustrative `₦500` fee remains `₦10,300` across checkout and pending status. |
| `MoneyStatus` / provider uncertain | Show order/reference and confirmation pending with Check order status/support. Retain the original attempt on reload; do not provide a second pay command while charge status is uncertain. Separate collection, refund requested/processed and pending/settled proceeds. |

### Filter drawer focus and persistence

A modal filter drawer has a programmatic name, close button and clear Apply/Clear actions. Opening moves focus to an appropriate heading or first control; contain keyboard focus while modal, make the background inert, and allow Escape to close. Closing returns focus to the invoking filter control; applying can announce the resulting count while preserving a predictable focus position. Opening/closing does not erase selections.

URL query/filter state and return scroll follow 05. Explicitly distinguish unapplied drawer edits from applied results. On resize to a persistent rail, remove modal trapping/inert state and keep the same selected values; never leave hidden focus. Essential filter groups do not require horizontal dragging.

### Drafts, formal offers and conflicts

Show “Saving”, “Saved [time]” or “Not saved / Retry” based on the actual result. Preserve entered fields, message text and upload references across validation, back navigation and recoverable interruption. Draft identity/version and persistence method belong to implementation design; do not claim a server save from local cache or expose another account's draft. Private identity/payment evidence is outside public previews and general-purpose browser draft storage.

If a newer draft/version exists, show the conflict and preserve the unsent work before an explicit reconcile/replace action. Hold, live-bid and paid-order constraints prevent incompatible item edits. Formal offer acceptance refreshes recipient permission, expiry, exact version and stock authority. Allocation success leads to the agreed amount and authoritative checkout expiry; stale, expired or stock-conflicting acceptance retains history and explains a safe next action. Expired allocation does not preserve an accepted stock promise; the fresh-agreement rule remains a policy proposal in 05.

## Handoff evidence and remaining checks

Observed for this revision: source contracts 02/05/07 and Avalon's design-system procedure were read; their established palette, geometry, journeys and truth requirements are retained in this contract. The earlier static editorial renders showed the intended visual language; corrected sample renders showed supported naira glyphs and consistent example totals. Those observations do not verify the proposed responsive or interactive behaviors above.

Before a later build is accepted, inspect representative catalogue, filters, setup, listing, conversation and checkout at 320/360/768/1200px, with long content and enlarged text. Verify actual focus/drawer restoration, keyboard operation, screen-reader naming/announcements, contrast in every state, font failure, draft recovery, stale-offer conflict and payment uncertainty. User task sessions, provider feasibility and owner policy decisions remain pending; neither static design review nor this specification counts as application test evidence.
