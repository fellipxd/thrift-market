# Thrift Market (working name)

A Nigeria-wide marketplace for secondhand fashion: shops, detailed condition-first listings, nearby discovery,
item chat with formal offers, scheduled auctions, protected platform checkout, hybrid delivery tracking,
disputes, verified-purchase reviews, follows/drops and labelled promotions.

> Status: development build. Payments and couriers run in **sandbox mode** (no real money or parcels).
> Provider, fee and protection-policy decisions are open — see `docs/decisions/decision-log.md`.

## Quick start

```bash
pnpm install
scripts/dev-setup.sh        # Postgres 16 + PostGIS (or: docker compose up -d postgres)
pnpm db:reseed              # schema + reference data + illustrative demo shops
pnpm dev                    # http://localhost:3000
pnpm dev:worker             # background worker (reservations, auctions, payouts, notifications)
```

Demo password for all demo accounts: `thrift-demo-pass` (e.g. `buyer@demo.thrift.test`, `amina@demo.thrift.test`,
`admin@demo.thrift.test`).

See `AGENTS.md` for architecture rules and conventions, and `docs/` for product, design and decisions.
