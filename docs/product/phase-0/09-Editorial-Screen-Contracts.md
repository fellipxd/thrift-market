# Editorial screen contracts

Revision 4, 9 October 2026. Continued design refinement follows the owner's editorial high-fashion direction. These are proposed interfaces for a later Next.js build. The four-page visual supplement adds seven screen/state examples to the original nine-page board; no application has been implemented.

## Screens and their decisions

| Visual supplement | Screen / journey | Inputs and hierarchy | Command and truthful result | Recovery contract |
| --- | --- | --- | --- | --- |
| 01 | Filter sheet / J03 | Destination first, then category, fit, condition, price range and sale mode; selected values stay visible. | Apply commits draft filter selections to the URL and returns to catalogue results. Cancel restores prior selections. Clear resets refinements while preserving the free-text query and destination; the control explains that scope. | Opening/editing the sheet does not discard the previous feed. Restore focus to the trigger on close. Distinguish a request failure from a completed empty response. |
| 01 | No matching stock / J03 | Current filter summary and short reason; no invented suggestions, counts or products. | Edit filters returns to current selections. Browse all pieces clears refinements and the free-text query, while keeping destination. | Unsupported route needs its own explanation and destination action. An empty feed cannot imply that all couriers are unavailable. |
| 02 | Shop setup / J01 | Public name, city/state, story and delivery coverage; private evidence is collected in a distinct step only under an approved policy. | Save draft persists entered fields with an observed saved time. Continue validates this step before moving on. | Failed save says that changes are unsaved, preserves current values and offers retry. Expired contact verification does not erase the shop draft. |
| 02 | Seller review pending / J01 | Factual pending status, saved shop identity and useful draft preparation action; no approved badge or invented review SLA. | Prepare a draft permits authoring only. Publishing/selling waits for required approval and other eligibility checks. | Rejection states the reason and permitted resubmission/appeal. Suspension preserves access to existing orders and support. |
| 03 | Listing composer / J02 | Actual-item photos, full view, back/label and disclosed cuff flaw; category, size/measurement, condition, stock, sale mode and asking amount. | Save and preview stores a draft then opens a buyer-facing preview. Preview is not publication. Missing evidence and eligibility failures block publication, while draft saving stays available. | Show an error summary and local field/media errors; retain text, upload references and source category version. Never label saving as saved until persistence is confirmed. |
| 04 | Formal offer in chat / J05 | Item context, messages, counterparty, amount, exact version, expiry and current recipient rights. | Only the opposing recipient can accept a valid current version. Acceptance atomically checks inventory, allocates if available and carries the agreed item amount to checkout. | Message text is not a price command. Keep typed messages on failure; allow safe retry. Sold stock or expired offer returns an explicit conflict without a purchase promise. |
| 04 | Stale offer / J05 | Prior version and amount remain readable as history; expired/superseded states remove acceptance. | View current offer opens the authoritative current version. Back returns to the preserved conversation. | Explain the conflict inline after a stale command. No automatic acceptance of the replacement. A pending command first reconciles before offering an action that could duplicate it. |

## Example listing and offer data

The supplement uses the same **illustrative** linen shirt as revision 3: M, chest 102 cm, good used, small mark on left cuff, one piece, asking price NGN 8,500. Missing back/label/flaw photos are deliberate examples of incomplete draft evidence. The generated front photograph is concept imagery and must not be used as an actual seller listing.

The conversation shows a buyer message proposing NGN 7,500 and seller counter version 02 for NGN 7,800. The mobile view demonstrates a later superseded state of that version; these are different times in the same example. Revision 3's checkout continues to use the accepted NGN 7,800 item amount plus NGN 2,000 delivery and NGN 500 illustrative fee, total NGN 10,300. The fee, hold and expiry examples do not approve business policy.

## Component and route ownership

Use [the responsive/component contract](08-Editorial-Components-and-Responsive-Spec.md), [art direction](07-Editorial-Art-Direction.md) and [journey/state map](05-Journey-States-and-Design-Decisions.md) together. The underlying authoritative mutation and money/stock semantics remain in [transaction contracts](06-Transaction-and-Data-Contracts.md).

| Proposed route | Design additions | Build boundary |
| --- | --- | --- |
| `/discover`, `/search` | Filter draft, applied URL state, no-match response and destination-preserving clear | Public listing data only; command results recheck actual availability. |
| `/seller` | Setup entry, pending status and draft preparation | Seller capabilities require request-specific authorization; public status omits private evidence. |
| `/seller/listings/[id]` | Draft composer, validation, save/preview and complete evidence | Category and draft versions preserved; publication uses server eligibility and required-photo checks. |
| `/inbox/[conversation]` | Formal current offer and historical/stale versions | Conversation membership and recipient rights are server enforced; client disabling is only guidance. |

## Design acceptance for a future interactive prototype

1. A buyer can narrow results, cancel edits and return from an item without losing destination or scroll context.
2. A seller can pause setup, recover the draft and understand pending approval without expecting immediate selling access.
3. A seller can disclose a flaw, attach its actual evidence and inspect the buyer preview; a failed upload does not erase other work.
4. A buyer can distinguish informal negotiation from the current formal counter and understand an explicit stock/version conflict.
5. Keyboard, assistive technology, 320 CSS-pixel reflow and 200% text enlargement work with real content, errors and long labels.

These are planned task checks. Static visual review and document validation do not establish interaction performance or application accessibility. Final identity requirements, category policies, legal/provider model and user task sessions remain open.
