# Load testing (T17)

Revision-bound scripts for the [proposed staging capacity gate](test-plan.md#proposed-staging-capacity-gate-targets-not-measurements).
They write synthetic users, listings and auctions, so they refuse any database not named `*_dev`, `*_e2e`, `*_load`
or `*_staging`, and any process with `NODE_ENV=production`.

```bash
# 1. A disposable database with reference + demo data, then the reference catalogue volume.
createdb thrift_load && psql thrift_load -c 'CREATE EXTENSION postgis; CREATE EXTENSION pg_trgm;'
DATABASE_URL=postgres://…/thrift_load pnpm --filter @thrift/application seed
DATABASE_URL=postgres://…/thrift_load pnpm --filter @thrift/application load fixtures --listings 100000

# 2. A production build of the web app against that database (APP_SECRET must be a strong random value).
pnpm build && APP_SECRET=$(openssl rand -hex 32) DATABASE_URL=… NODE_ENV=production pnpm start

# 3. Scenarios (each prints p50/p95/p99 per group, status counts and a verdict against the proposed targets).
pnpm --filter @thrift/application load reads    --base URL --rate 200 --duration 3600     # mixed browse: search, item, home, shop, auction polling
pnpm --filter @thrift/application load reads    --base URL --rate 500 --duration 300      # burst
pnpm --filter @thrift/application load bids     --base URL --auctions 1000 --bidders 2000 --rate 50 --duration 600
pnpm --filter @thrift/application load hot-item --buyers 200                               # one unique piece, many buyers at once
pnpm --filter @thrift/application load search   --runs 30                                  # read-only: search query cost (text, typo, price-sorted category)
```

- **reads** is open-loop: it starts the requested number of requests per second however slowly earlier ones finish, so
  saturation shows up as latency and errors rather than as a quietly lower rate. 404s are expected outcomes.
- **bids** creates live auctions through the real `createAuction` use case (copies of a seeded auction piece with its
  photos) and bids over HTTP with bearer sessions. Too-low (409), rejected (400/422) and rate-limited (429) bids are
  expected outcomes. Afterwards it checks that every auction's bid sequence is gap-free with strictly rising amounts.
- **search** runs the search use case in-process, one call at a time, so it measures query cost without HTTP or
  concurrency. `--word`, `--words`, `--typo` and `--category` swap in terms that exist in the data being measured.
- **hot-item** runs in-process because checkout is a server action with no JSON API; it checks exactly one live order
  and a balanced stock row.

## First run (2026-10-13) — local container, not a staging measurement

One 4-core / 16 GB container running PostgreSQL 16, **one** Next.js production process (default pool of 10
connections) and the load generator together. These figures only show relative behaviour and what broke; they say
nothing about staging capacity, which needs real hardware, several web processes and a separate load host.

**What the run found and fixed (migration `0910`, `discovery/shops.ts`, `discovery/home.ts`, `discovery/search.ts`):**

| Finding at 100,000 listings | Effect | Fix |
| --- | --- | --- |
| Shop cards (home "Shops to discover", nearby, following) counted every listing of every shop with a latest-auction lookup per listing, and sorted each shop's whole catalogue by an unindexable expression for thumbnails | `/nearby` 720 ms and home 790 ms with no load; under 50 req/s the 10-connection pool ran dry → 91% of requests failed (`timeout exceeded when trying to connect`) | Count fixed-price pieces with a partial index and add live auctions from the auctions table; thumbnails read the newest pieces through a new `(shop_id, published_at DESC, id DESC)` partial index. `/nearby` → 28 ms |
| Auction lists (home live/upcoming, `/auctions`) filtered `sale_mode = 'auction'` without an index | ~95 ms each (full catalogue scan) | Partial index on auction listings → 0.2 ms |
| Category counts (home quick filters) and size facets (search filters) aggregated the whole catalogue on every request with a per-row auction join | 250 ms and 140 ms per request | `EXISTS` on the open auction (one per listing) instead of the join, and a 60-second single-flight in-process cache for these public, non-personal aggregates |

**Results after the fixes (60 s each):**

| Scenario | Rate | Result |
| --- | --- | --- |
| reads | 20 req/s | worst p95 313 ms (text search), 0 errors — within targets |
| reads | 35 req/s | worst p95 391 ms (text search), 0 errors — within targets |
| reads | 50 req/s | p50 63–231 ms but worst p95 1.2 s (item page), 0 errors — **outside** targets: the shared container is CPU-bound (before the fixes: 91% errors at this rate) |
| bids | 25 bids/s, 20 auctions, 100 bidders | p95 20 ms, 1,476 accepted, 23 too-low; invariants hold |
| bids | 50 bids/s, 50 auctions, 200 bidders | p95 17 ms, 2,983 accepted, 16 too-low; invariants hold |
| hot-item | 200 buyers at once | 1 order, 199 `STOCK_CONFLICT`, stock balanced; p95 517 ms (all 200 queue for 30 connections) |

**Overload behaviour (2026-10-13):** with a one-connection web pool and the auctions table locked for 12 s, 19 of 20
concurrent API requests got `503 BUSY` with `Retry-After: 5` (one short log line each) instead of `500`, and requests
succeeded again as soon as the lock cleared. Form submissions show “busy, nothing was changed”.

**Search follow-up (2026-10-13, `load search`, p50 / p95):** price-sorted pages priced and sorted every piece in the
category through the auction join (200–250 / 320–360 ms per large category, 815 / 1,017 ms across everything). Fixed-price
pieces now come off price-ordered partial indexes (migration 0940) with auction pieces merged by current bid, and the
card query only looks up auctions for auction listings: 6–7 / 10–11 ms. Text search matches exactly first and only widens
to spelling correction and trigram similarity when exact matches fill less than a page (one common word 110 → 72 ms;
"shrit" now finds shirts).

**Watch items for the staging run:**

- Relevance-ranked text search still scores every match: 72 ms p50 for a word matching ~6,300 of 100,000 synthetic
  pieces (the synthetic catalogue's small vocabulary makes matches unusually broad). Measure with `load search` on
  realistic titles before considering a candidate cap or a dedicated search service (ADR-0007).
- Web processes and `WEB_DB_POOL_MAX` must be sized together against PostgreSQL's connection limit.
- Not covered yet: the 1,000-concurrent-session mix with signed-in pages, 1,000 scheduled auctions closing, job lag and
  queue depth under load, image delivery (CDN), backup restore (T18).
