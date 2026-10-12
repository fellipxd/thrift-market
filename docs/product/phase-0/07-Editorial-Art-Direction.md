# Editorial fashion art direction

Revision 3, 9 October 2026. The owner requested an **editorial, high-fashion** style. This governs the visual direction for future interface design and the revised concept PDF. Next.js remains selected for a later build.

## Design concept

Treat discovery as a curated fashion publication: prominent high-contrast serif masthead, photography-led compositions, generous ivory space, asymmetry, fine rules and small tracked labels. **THRIFT** is the working descriptor in the concept; final name remains open. Buyers must still see a piece's wear, price, fit, sale mode and delivery.

Revision 3 replaces the previous rounded schematic layouts with straight edges, open product compositions, quiet metadata, larger photography and expressive display typography. Deep green is a considered accent for important actions. Public discovery carries the strongest fashion expression; checkout and operations use a quieter version of the same language.

## Visual system

| Role | Direction | Constraint |
| --- | --- | --- |
| Paper | Warm ivory `#F7F3EB`, occasional white operational surface | Clean text areas, generous intentional space. |
| Ink | Near-black `#171B18` | Headlines, product names and prices; contrast calculated against ivory. |
| Accent | Deep green `#174A3C` | Main action and selected navigation; used sparingly. |
| Detail | Muted `#59665D`, fine neutral rules | Condition and fees remain readily readable. |
| Display | Bodoni-style high-contrast serif | 72-112px desktop cover, 44-64px mobile campaign; short semantic lines. |
| Reading/UI | Clean humanist or neutral sans | Eventual mobile body 16px; metadata 14-16px; tabular price figures and verified naira glyph support for every monetary amount. |
| Navigation | Tracked labels, quiet masthead | Minimum practical touch area around small text; visible focus and accessible names. |
| Shape | Flat open layout, square image and button geometry | 0-2px control radius; no decorative shadow or floating card wall. |

The concept uses locally installed Bodoni MT and Segoe UI to show proportion. Their font files are not copied into the repository; licensed webfont equivalents and loading remain build decisions. Local rendering is not evidence of a web redistribution licence.

## Composition rules

Desktop uses a twelve-column modular grid with generous outer margins and deliberate asymmetry. Each composition has one primary focal anchor: campaign image on home, garment image on product, amount/status on a transaction. Supporting text leads to a concrete action. Do not give three large elements equal emphasis.

Mobile keeps search and selected destination reachable above campaign content. Bound the campaign to part of the first screen and expose a product preview promptly below it. Browse uses a regular two-column product grid. Product gallery includes full item views as well as optional editorial crops; condition, measurement, seller and route stay close to purchase. Auction and checkout reveal terms before confirmation.

An expressive cover at `/` can lead to the efficient catalogue at `/discover`. This is a proposed route/layout, not an application. Existing discover/saved/sell/inbox/account journeys remain available. Essential actions never require horizontal dragging.

## Photography

Campaigns use sculptural natural light, warm plaster/stone, confident candid adult subjects, visible material texture and restrained styling. The original generated images communicate atmosphere only. They are labelled illustrative in the board and must never represent real seller inventory.

Listing photography uses the actual piece with full front/back/label/sole/lining views where relevant and separate flaw close-ups. Beautiful cropping cannot hide evidence. The generated shirt and leather bag are placeholders for real inventory photography. Exact prompts and tool provenance are saved in `editorial-image-provenance.json`; workspace copies are in `outputs/editorial-assets`.

## Application by screen

| Surface | Fashion expression | Task clarity |
| --- | --- | --- |
| Home/discover | Large masthead, editorial story, asymmetric campaign and curated drops | Search, destination and products visible promptly. |
| Product | Large actual-item image, serif name, open price rail, ruled details | Condition/flaws, measurements, seller and route; correct sale-mode actions. |
| Seller boutique | Shop as a fashion archive with its own story | Approximate location, coverage, identity explanation and review sample. |
| Auction | Dramatic item image and confident price | Minimum bid, authoritative end/extension, shipping and winning obligation. |
| Offers/checkout | Paper-like terms and disciplined typography | Exact total, accepted terms, hold/pending state and safe next action. |
| Seller/staff | Typographic tables, restrained rules, spacious lists | Clear tasks, separate financial states and scoped permissions. |

## Validation

Inspect thumbnail hierarchy and grayscale separation, semantic line breaks, clean text zones, margins and accidental tangencies. Colour arithmetic only checks specified token pairs. Actual keyboard, assistive technology, zoom/reflow, focus and error-state validation belongs to future interactive UI work.

The direction succeeds if public screens read as fashion editorial at first glance while a buyer can find price, condition, fit, sale mode, seller and delivery. Buyer/seller task validation remains pending. No final brand, fee, auction policy or payment model is implied by the imagery.
