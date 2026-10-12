# Journey and interaction refinement

Journey contracts introduced in revision 2, with editorial refinements in revisions 3-4, 9 October 2026. The owner selected continued design refinement. Next.js remains the chosen framework for a later implementation. The visual boards are static editorial design concepts with illustrative items and amounts; they are not working applications.

## Decisions made for the design proposal

The following are reversible design choices, not newly approved business policies: keep a product feed above the fold; use a list before an optional nearby map; offer one account with buyer and seller capabilities; preserve list filters in the URL and draft form data across interruptions; show separate item, dispatch, payment and payout states; use formal offer cards inside chat; place the destination check before the final checkout action. Final name stays a working descriptor. Identity verification, service reputation and sponsorship always have distinct explanations.

## Twelve critical journeys

| Journey / requirements | Entry and success path | Interruption, conflict and recovery | Design acceptance |
| --- | --- | --- | --- |
| J01 Contact and seller setup / R01-R03 | Sell action explains shop setup; verify contact; enter public shop identity/city and coverage; submit required evidence; save a draft. Approved status permits public selling. | Expired verification link preserves entered fields. Rejected evidence gives specific reason and appeal; suspension blocks new sales while fulfilment/cases stay accessible. | One account still buys. Private address and evidence never appear in preview. Pending is not labelled approved. |
| J02 Detailed listing / R04-R06,R24 | Category selects versioned fields; original photos; condition and flaws; size/measurements; stock model; coverage; sale mode; buyer preview; publish when eligible. | Upload retry does not duplicate media; offline/reload preserves draft; category change asks before clearing incompatible fields. Existing hold/bids prevent destructive mode/stock edits. | Seller can disclose a cuff stain, attach evidence, and see it in buyer preview. Batch pieces remain distinct. |
| J03 Find and inspect / R07-R08 | Search/category/size/condition/mode; typed destination; open item; inspect all photos, flaw description, measurements, seller and delivery. | No match offers editable filters. Withdrawn listing retains a truthful unavailable page. Back navigation restores filters/scroll. Location permission denied offers typed city. | Guest can evaluate an item without sign-up; listing card does not imply deliverability from proximity alone. |
| J04 Shop and follow / R03,R19,R21 | Shop link shows catalogue, approximate location, coverage, identity status and purchase-based service sample; choose follow; explicit channel choices for notices. | New seller has no invented reputation. Suspended shop explains unavailable sales; previously purchased order/help remain reachable. Unsubscribe is available from notice and preferences. | Follow is separate from marketing consent. Paid promotion cannot change identity or trust. |
| J05 Message and negotiate / R09-R10 | Item context opens scoped chat; create amount/expiry card; seller counters; the recipient accepts exact version; successful acceptance creates a temporary stock allocation and checkout link. | Chat send fails with retry state. Stale/expired offer cannot be accepted. If stock lost, show conflict without an accepted promise. A missed checkout hold ends that acceptance; a fresh agreement is needed. | Message text alone does not change payable price; buyer sees accepted amount, delivery and fees before pay. Blocking does not erase order evidence or stop support. |
| J06 Fixed checkout / R12-R14 | Confirm destination, current item version, route and itemized total; request checkout allocation; show authoritative expiry; start provider payment. | Cart saves interest only. Stock loss returns reserved/sold state. Quote expires or price changes before initiation: refresh total and request confirmation. Duplicate tap reuses the attempt. | Countdown is informational; success is server-confirmed. No provider call runs while the stock transaction is locked. |
| J07 Payment recovery / R13-R14 | Provider return leads to order status; verified result confirms paid or failure. Uncertain result explains that confirmation is pending and offers status refresh/support. | Reload, timeout or missing webhook preserves original reference and order. Do not offer a second pay button while charge is uncertain. Late payment after released stock enters refund/exception status. | Copy distinguishes charged, confirmed, pending, refund requested and refund processed. Timers never imply payment failed. |
| J08 Auction / R11 | Inspect condition and route estimate; review start/end/extension/increment/winner obligation; confirm bid; receive accepted server sequence; watch current minimum and leadership. | Bid waiting on lock is evaluated against time after lock acquisition; outbid gets current minimum. Reconnect refreshes snapshot. Closing worker delay shows 'Closing - checking final result'. | An auction exclusively owns its one piece during its live lifecycle. Bid is not payment. Local timer alone never declares the winner. |
| J09 Winner checkout / R11-R14 | Confirmed winner gets item/order terms and payment deadline; use dedicated checkout; verified payment starts fulfilment. | Missing winner payment uses approved relist/second-chance rule. Provider-pending winner payment is reconciled before any stock release. Losing bidder is never automatically charged. | Seller cannot sell the same unit elsewhere during active winner obligation. Recovery deadline and support action are visible. |
| J10 Fulfilment and complaint / R15-R17 | Seller selects an eligible route and dispatches; buyer timeline labels courier or seller evidence and last update; buyer can report non-delivery, wrong item, undisclosed flaw or transit damage. | Courier outage shows last known state; seller report cannot alone trigger payout. Support requests evidence with deadline; reasoned resolution and appeal preserve purchase snapshot. | Cost, dispatch promise and transit estimate are distinct. Delivery status and payment release are distinct. |
| J11 Review and reputation / R18-R19 | Eligible completed order-item opens review form; rating dimensions, written review and seller reply; display count and period. | Duplicate/ineligible/self review denied with explanation. Moderation reason is logged; refund-related eligibility follows versioned policy. | Public trust panel explains identity separately and never hides tiny sample sizes. |
| J12 Promotion and metrics / R20,R22-R23 | Eligible seller sees defined price/duration/audience, sponsored preview and total; approves campaign; dashboard separates impressions, item clicks, orders and proceeds. | Sold/suspended or unavailable item stops serving. Remaining duration/credit/refund follows approved policy. Metrics lag displays update time. | Sponsored label survives every surface; no ranking or trust promise beyond approved paid exposure. |

## Detailed screen states

### Proposed Next.js route map

| Route | Audience / guard | Preserved navigation state |
| --- | --- | --- |
| `/` | Public editorial cover linking to the catalogue; proposed in revision 3 | Search/destination immediate; campaign bounded with product preview. |
| `/discover`, `/search` | Guest public published data | Query, category, destination, size, condition, mode, sort and cursor in URL; scroll on return. |
| `/items/[slug]`, `/shops/[slug]` | Guest public details; private actions authenticate | Origin filters; actual item/version availability refreshed for commands. |
| `/saved`, `/inbox/[conversation]` | Own account and conversation membership | Saved state; message drafts; exact offer version. |
| `/auctions/[id]` | Public state; bid requires eligible account | Authoritative auction snapshot/sequence on reconnect. |
| `/checkout/[group]`, `/orders/[id]` | Buyer owner or narrowly scoped seller/staff order view | Frozen checkout/order snapshot, attempt reference, server status. |
| `/seller`, `/seller/listings/[id]` | Shop membership and allowed capability | Draft version, upload progress and filter/action context. |
| `/staff/cases/[id]` | Assigned staff permission; finance/identity scopes distinct | Case version, evidence references and approval intent. |

Routes are a design map, not created application files. Authentication returns the user to the intended authorized route after a fresh server check. Public cached payloads contain public data only; private screens require request-specific authorization.

| Surface | Loading/empty | Authoritative change | Error and work preservation |
| --- | --- | --- | --- |
| Listing wizard | Indicate photo progress and draft saved time; first item explains required photos. | Schema/category/policy version captured; hold/live bid blocks incompatible edit. | Keep text/media reference on retry. Error summary links to field, focus placed usefully. |
| Item detail | Skeleton with stable dimensions; no false available badge before data. | Reserved, sold, paused, revised version or no route replaces actions explicitly. | Photo failure has descriptive alternative; restore prior filter context. |
| Offer card | Draft amount and expiry; no reserve claim. | Accept/counter/expire versions show actor and exact state. | Stale/conflict keeps history and shows valid next action; never silent auto-accept. |
| Auction | Upcoming schedule or loading current minimum; public history omits personal identity. | Accepted/outbid/extended/closing/winner states come from server. | Disconnection disables authoritative bid confirmation until refresh; failed bid does not erase typed amount. |
| Checkout | Loading route/fees prevents payment action. | Server-backed hold/quote/version changes shown with changed total confirmation. | Pending payment retains order reference; recovery avoids duplicate pay. |
| Order/case | No tracking yet is distinct from loading and from courier outage. | Evidence-source labels, refund and payout updates remain separate. | Report form draft survives interruption; attachment retry keeps case ID. |
| Seller dashboard | Zero orders/reviews is factual; no fabricated momentum. | Counts include own shop and specified time window only. | Delayed stats show update time; action queues remain independent of analytics outage. |

## Responsive and accessible behavior

Use a two-column item grid on normal mobile widths and one column when enlarged content requires it. The item's main action may be sticky only if it does not cover content, errors or keyboard focus. Gallery expands with labelled controls; measurement tables use text/unit labels. Filters have a clear heading, focus return and clear-all action. Seller tables become stacked, ruled records on narrow screens. Do not require horizontal dragging for essential actions.

Rapid auction changes must not flood screen readers: announce a user's accepted/rejected bid, outbid state and meaningful close change; allow a visible refresh. The countdown is not announced every second. Use text plus icons for all states, visible focus, reduced motion and appropriate semantics. The colour ratios in document 02 remain palette arithmetic only; the assembled UI still requires keyboard, assistive technology, zoom/reflow and contrast validation.

## Policy workbook for owner review

These defaults are **proposals** for evaluating the screens, not active business terms. They are intentionally not baked into the architecture.

| Decision | Proposed starting point / alternative | Must be resolved before |
| --- | --- | --- |
| Hold duration / abuse | Start evaluating the source plan's 10-minute hold with one active scarce-item checkout per buyer; allow renewal only under an explicit rule. | Real checkout. |
| Accepted offer | Atomic allocation on acceptance, same short payment hold, clearly expired acceptance if not paid; no guaranteed stock after expiry. | Bargaining acceptance. |
| Auction close | Simple increments, disclosed short anti-sniping extension, a bounded maximum extension and an outage rule. Exact values and obligations need owner approval. | Auction launch. |
| Shipping quote | Frozen total for a valid checkout authorization; if quote invalidates before provider initiation, reconfirm. Provider-pending attempt does not silently change payable amount. | Payment/delivery. |
| Verification | Status communicates scope; manual review can be designed before an identity vendor is selected. Data retention and reviewer access need approval. | Identity evidence collection. |
| Categories | Reject illegal/counterfeit/stolen listings; explicitly review hygiene/intimate wear and authenticity policy. | Public publication. |
| Case deadlines / release | Receipt, buyer silence, disputes, evidence and appeals must follow a feasible provider/consumer policy; no default auto-release chosen here. | Protected checkout. |

## Design research next steps

Use the visual board as a discussion stimulus, then build an interactive design prototype only if that improves testing. A static PDF cannot test navigation performance or actual accessibility. Validate J02, J03, J05, J08 and J10 with the proposed seller/buyer task sessions; record observed task outcomes and revise the screen contract. Avoid counting a reviewer's opinion as user research. Provider/legal/commercial questions remain in the decision register and do not disappear because the screens look complete.
