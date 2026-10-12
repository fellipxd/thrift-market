# ADR-0009: Same-seller bag; a pending order is the checkout group, with one hold per item

Status: Accepted, 2026-10-12. Relates to phase-0 doc 06 (all-item checkout and early snapshot), R12–R15, ADR-0002 and
ADR-0008.

## Context
Doc 06 asks for a cart that is only an interest list, and a `CreateCheckoutGroup` command that takes several
listings from **one seller**, locks every stock row in sorted order and allocates **every item or none**, freezing
the snapshot before the provider is called. One group expires and reconciles as a unit; a child is never dropped
silently once payment starts. Accepted offers and auction wins keep their dedicated checkouts. Until now checkout
covered one listing (with a quantity) per order.

## Decision
1. **Bag = interest only.** `bag_items` (user, listing, quantity, price when added) never touches stock. Only pieces
   that could be bought at a fixed price right now can be added; own-shop and auction pieces are refused. The bag page
   shows each piece's live state (available, held for you, on hold for another buyer, sold, not for sale) and a price
   change since it was added. Size is capped by `max_bag_items` (draft 20; doc 06 leaves the limit to measurement).
2. **The pending order is the checkout group.** No separate group table: an order in `pending_payment` already has
   the buyer, seller, frozen snapshot, deadline and payment attempts doc 06 lists. Each `order_items` row now carries
   its own `reservation_id`. `orders.reservation_id` stays only for single-hold orders (single-piece checkout,
   accepted offer, auction win, second chance), where its partial unique index guards one live order per dedicated
   hold; multi-piece orders leave it NULL (their holds are created fresh in the same transaction, so nobody else can
   attach an order to them). Existing orders were backfilled (each had exactly one item).
3. **All or none, in lock order.** `startBagCheckout` validates that every piece belongs to the named shop, then in
   one transaction loads each listing and reserves it through the inventory authority **in listing-id order**. The
   buyer confirms the unit prices they saw; a changed price, a sold/reserved piece or a quantity shortfall throws,
   rolling back the holds already taken, and the message names the piece. Same-transaction order + item snapshots +
   payment attempt; the provider is called after commit (ADR-0002).
4. **The group moves as one.** Every path visits an order's holds in listing-id order (`checkout/holds.ts`):
   - expiry: the first due hold releases every hold of its unpaid order and cancels the order once; a pending
     provider outcome puts every hold into the payment grace period together;
   - buyer cancel releases every fresh hold; retry requires every hold to still be active (earliest deadline);
   - capture locks all stock rows then all holds; it converts all of them, re-allocating released units only if
     **every** piece is still free; otherwise nothing is sold, any hold still live is released and the whole payment
     is refunded (`late_payment_after_release`);
   - seller cancellation before dispatch restores (or withdraws) every piece.
   Paid pieces leave the buyer's bag in the capture transaction.
5. **One parcel, one delivery fee.** A bag order ships together. Options are the methods every piece supports, at the
   highest quoted fee and longest dispatch/transit (`combineDeliveryOptions`); coverage and zone fees are per shop,
   so pieces normally quote the same. Courier booking sends the parcel's total weight. Weight-based courier pricing is
   not modelled yet (sandbox routes have a base fee) — when a contract prices by weight the quote must use total
   package attributes (doc 06) — D09.
6. **Frozen apportionment.** Order-level delivery fee, buyer fee and commission are split across items by item total
   with integer largest remainder (`apportionMinor`) and stored on each item, so a later partial refund uses the split
   the buyer accepted. Buyer fees apply to the items total (no per-piece flat fee). Partial item refunds themselves
   are not built: cancellations and refunds stay order-level commands.
7. **Hold limit counts pieces.** `max_active_reservations_per_buyer` limits pieces held at once; a bag checkout needs
   room for all of its pieces or is refused before holding anything.

## Consequences
- Order lists show the first piece and "and N more"; order, payment and seller pages list every piece.
- Late-payment handling for multi-piece orders is stricter than for single pieces only in the sense doc 06 asks:
  never a partial sale.
- Cross-seller carts remain out of scope (doc 01).
