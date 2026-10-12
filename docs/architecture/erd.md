# Entity relationship overview

Full DDL: `packages/database/migrations/0001_core_schema.sql`. Key relationships:

```mermaid
erDiagram
    users ||--o{ sessions : has
    users ||--o{ role_grants : "staff roles"
    users ||--o{ addresses : "private"
    users ||--o| shops : owns
    shops ||--o{ shop_members : has
    shops ||--|| delivery_coverage : declares
    shops ||--o{ verification_cases : submits
    shops ||--o{ payout_accounts : "one active"
    categories ||--o{ attribute_schema_versions : versions
    shops ||--o{ listings : lists
    listings }o--|| attribute_schema_versions : "created with"
    listings ||--o{ listing_versions : "immutable versions"
    listings ||--o{ listing_media : photos
    listings ||--o{ listing_flaws : discloses
    listings ||--|| inventory_stock : "stock authority"
    listings ||--o{ reservations : holds
    listings ||--o| auctions : "auction mode"
    auctions ||--o{ bids : receives
    listings ||--o{ offer_threads : negotiations
    offer_threads ||--o{ offers : versions
    reservations ||--o| orders : "one live order"
    orders ||--|{ order_items : "snapshots"
    orders ||--o{ payment_attempts : pays
    orders ||--o| shipments : ships
    shipments ||--o{ shipment_events : tracks
    orders ||--o| payouts : "seller payable"
    orders ||--o{ refunds : refunds
    orders ||--o{ disputes : disputes
    order_items ||--o| reviews : "one review"
    ledger_transactions ||--|{ ledger_entries : "balanced"
    conversations ||--o{ messages : contains
    users ||--o{ follows : follows
    users ||--o{ saved_items : saves
    shops ||--o{ ad_campaigns : promotes
```

Integrity highlights: stock CHECK invariant; one active reservation per (source, source_id); one live order per
reservation; one succeeded payment attempt per order; one payout per order; one review per order item; one active
dispute per order; ledger transactions must balance (deferred trigger) and are append-only; audit events append-only.
