# Thrift Market (working name)

A Nigeria-wide marketplace for secondhand fashion: shops, detailed condition-first listings, nearby discovery,
item chat with formal offers, scheduled auctions, a same-seller bag and platform checkout (holds every piece or none;
the protection model awaits decision D04), hybrid delivery tracking,
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
`admin@demo.thrift.test`). Staff tools ask for a two-step code: the demo staff accounts (admin@, finance@, support@)
are enrolled with the development-only authenticator secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` — add it to any
authenticator app. The seed never enrols it when `NODE_ENV=production`.

If `pnpm dev` keeps reloading a page by itself (seen on slow or cold filesystems, where the file watcher misfires), stop it,
delete `apps/web/.next/dev` and start it again.

Tests: `pnpm test` (domain + application, against `thrift_test`), `pnpm test:e2e` (Playwright, both phone and desktop,
including automated accessibility checks). Load scripts for the staging capacity gate: `docs/qa/load-testing.md`.

See `AGENTS.md` for architecture rules and conventions, and `docs/` for product, design and decisions. The phase-0 design
packet (requirements, journeys, transaction contracts and the owner-selected editorial art direction) is in
`docs/product/phase-0/`; `docs/product/traceability.md` maps it to the code and lists known gaps.
