# Thrift Market — engineering guide for humans and agents

Nigeria-wide marketplace for secondhand fashion (clothes, shoes, bags, accessories). Source plan:
`docs/product/` (requirements R01–R25), decisions in `docs/decisions/`. "Thrift Market" is a **working name** (decision D01 open).

## Authority and honesty rules

- Risk level L3 (payments, identity data, access control). No production deployment, provider onboarding,
  spending or external messaging without an explicit owner instruction.
- Payments and couriers run through **sandbox adapters** that are visibly labelled. Never present a mock as
  working protection or a real integration. The Paystack adapter exists but stays disabled until decision D04.
- Commission/fees default to **zero** (decision D05 open). Never invent pricing; itemise whatever applies.
- Owner decisions that are fixed: Nigeria nationwide; protected platform checkout; bargaining **and** auctions in
  first launch; separate sale modes (never auto-convert fixed price to auction); modern thrift boutique brand;
  platform + seller delivery options.
- Do not mark a requirement as done without test evidence. Simulated reviewers are not independent reviewers.

## Layout

```
apps/web          Next.js 16 App Router: buyer storefront, seller workspace (/sell), admin (/admin), /api/v1, webhooks
apps/worker       Durable background worker (tsx). No Next.js imports.
packages/domain   Pure rules: money, listing checklist, stock math, offers, auctions, state machines, delivery, reputation
packages/application  Use cases (transactions, authz, orchestration), seed, tests. Shared by web + worker.
packages/database Pool, transaction helper, migrations (SQL), migration runner
packages/contracts Zod input schemas shared by API, server actions and use cases
packages/providers Payment/courier/notification/storage adapters + sandbox implementations, image processing
docs/             Product, decisions/ADRs, architecture, security, QA evidence
```

## Commands

```
pnpm install
scripts/dev-setup.sh          # Postgres 16 + PostGIS on Ubuntu (or: docker compose up -d postgres)
pnpm db:reseed                # reset dev DB, migrate, seed reference + illustrative demo data
pnpm dev                      # web on :3000
pnpm dev:worker               # worker loop
pnpm typecheck                # all packages
pnpm --filter @thrift/domain test        # unit tests
pnpm --filter @thrift/application test   # integration tests on real Postgres (thrift_test DB, reset per run)
pnpm --filter @thrift/web build          # production build check
```

Demo accounts (dev only, password `thrift-demo-pass`): `admin@demo.thrift.test` (admin+trust_safety),
`finance@`, `support@`, `buyer@`, `buyer2@demo.thrift.test`; sellers `amina@`, `tunde@`, `ebi@`, `musa@demo.thrift.test`.

## Architecture rules (non-negotiable)

1. **PostgreSQL is the authority** for stock, reservations, bids, orders and money records. Caches, search,
   client state and live updates are projections and must be revalidated at checkout.
2. **All stock allocation goes through `packages/application/src/inventory/authority.ts`**
   (`reserveStock`, `releaseReservation`, `convertReservation`, `withdrawStock`, `restock`). Never update
   `inventory_stock` anywhere else.
3. **Lock order** (always): `auctions → offer_threads → inventory_stock → reservations → orders → payment_attempts → payouts`.
4. **Short transactions; no external calls inside them.** Reserve/record → commit → call provider → apply the
   verified result in a new guarded transaction. Unknown provider outcomes become `uncertain` and are reconciled.
5. **Money** is integer minor units (kobo) + currency. Use `@thrift/domain` money helpers. Never floats.
6. **Idempotency**: duplicate commands/webhooks must produce one effective transition (unique keys, status
   guards, `withIdempotency`, outbox `dedupeKey`, webhook inbox dedupe).
7. **Separate state machines** for order, payment, fulfilment, payout, dispute, refund (`domain/state-machines.ts`).
   Use `assertTransition` before changing a status.
8. **Order snapshots are immutable**: what the buyer purchased (description, condition, flaws, media, price, fees,
   delivery terms, policy versions) is copied at order creation.
9. **Server time decides**: auction validity is checked with `ctx.now()` read after acquiring the auction lock.
10. **Seller-reported delivery never releases a payout by itself.** Buyer confirmation, courier verification or a
    staff decision is required, and an open dispute blocks release.
11. **Ads never buy trust.** Sponsored items are always labelled; sold/unavailable items leave promotion.
12. **Authorisation on every object** (OWASP BOLA). UI hiding is not authorisation. For other people's objects return
    `NOT_FOUND`, not `FORBIDDEN`. Never expose `min_offer_minor`, full addresses (except to the seller of a paid
    order), payout details, verification evidence or other users' private data.
13. Domain/application code must not import Next.js or React. Web code must not contain SQL — put queries in
    application modules (`*/queries.ts`) and mutations in use cases.

## Use case conventions (`packages/application/src/<module>/`)

```ts
export async function acceptOffer(ctx: AppContext, raw: unknown): Promise<AcceptOfferResult> {
  const user = requireVerifiedUser(ctx);                  // 1. who (requireUser / requireVerifiedUser / requireStaff)
  const input = parseInput(acceptOfferInput, raw);        // 2. validate with a contracts schema
  await enforceRateLimit(ctx.pool, `offer:${user.userId}`, 30, 3600); // 3. abuse control where relevant
  return withTransaction(ctx.pool, async (tx) => {        // 4. short transaction, lock in the documented order
    // object-level ownership check → NOT_FOUND if not theirs
    // assertTransition(...) before status changes
    // reserveStock(tx, ...) for any allocation
    // recordAudit(tx, ctx, ...) for staff / money / sensitive actions
    // enqueue(tx, { topic, dedupeKey }) and notifyUser(tx, { dedupeKey }) for side effects
  });
}
```

- Throw `DomainError(code, message, details)` from `@thrift/domain`. Codes: `VALIDATION_FAILED`,
  `UNAUTHENTICATED`, `CONTACT_UNVERIFIED`, `FORBIDDEN`, `NOT_FOUND`, `STOCK_CONFLICT`, `EXPIRED`, `INVALID_STATE`,
  `CONFLICT`, `RATE_LIMITED`, `PROVIDER_PENDING`, `PROVIDER_ERROR`, `NOT_DELIVERABLE`.
  Field errors: `details.fieldErrors = { fieldName: 'message' }`. Messages are user-facing, plain and specific.
- Read models live in `queries.ts` files returning plain serialisable objects (camelCase, ISO dates where sent to
  client components).
- Settings (hold minutes, deadlines, fees) come from `getSettings(db)`; never hard-code policy numbers.
- Each module exports from its `index.ts`; add one line to `packages/application/src/index.ts`.
- Background work: export `register<Module>Jobs()` that calls `registerTask` / `registerOutboxHandler`, and add one
  line in `packages/application/src/jobs/registry.ts`. Tasks must be idempotent scans using `FOR UPDATE SKIP LOCKED`.

## Database

- Schema: `packages/database/migrations/0001_core_schema.sql` (all domains). **Never edit an applied migration.**
  Add new files. To avoid collisions between parallel slices use the slice's number range
  (e.g. `0310_checkout_indexes.sql` for slice 3 → 0300–0399).
- Use parameterised queries only (`$1`). Helpers: `one`, `maybeOne`, `many`, `exec`, `withTransaction`.
- `int8` parses to `number`; `numeric` to `number` (ratings/coordinates only).

## Web conventions (`apps/web/src`)

- Pages are server components. Get context with `getCtx()`; gate with `requireUserPage(path)` /
  `requireVerifiedPage(path)`. Next 16: `params`/`searchParams` are Promises.
- Mutations: co-located `actions.ts` with `'use server'`, each returning `ActionState` via `runAction(ctx => useCase(ctx, formObject(form)))`,
  rendered with `<ActionForm action={...}>` + `TextField`/`SelectField`/`TextAreaField`/`CheckboxField` + `SubmitButton`
  (field errors flow automatically). Redirect only after checking the returned state.
- JSON API: `app/api/v1/**/route.ts` using `apiRoute(async (req, ctx, params) => ...)` (CSRF same-origin check,
  Bearer or cookie auth, stable error bodies). Webhooks: `app/api/webhooks/<provider>/route.ts`.
- Links: always `routes.*` from `@/lib/routes`. Formatting: `@/lib/format` (₦ via `formatNaira`, WAT times).
- UI kit in `components/ui`: `Button`/`ButtonLink`, `Card`/`CardSection`/`StatTile`, `Badge` (status text always
  present), `Alert`, `EmptyState`, `PageHeader`, `Price`, `Photo`, `Countdown` (server-time corrected),
  `ListingCard`/`ListingGrid`, `ActionForm`, fields. Workspace pages render inside `WorkspaceShell` layouts.
- Brand tokens (Tailwind): `bg-canvas`, `bg-surface`, `bg-sand`, `text-ink`, `text-muted`, `bg-primary`,
  `text-primary`, `bg-primary-soft`, `text-accent`, `bg-accent-soft`, `border-line`, `border-line-strong`,
  `text-error`/`bg-error-soft`, `success`, `warning`, `info`; `font-serif` for editorial headings only.
- Accessibility target WCAG 2.2 AA: labels on every control, 44px targets, visible focus, statuses as text,
  keyboard-operable flows, `aria-live` for changing auction/countdown values where useful.
- Copy: clear, warm, fashion-literate, plain about price/condition/delivery. Scarcity only from real stock.
  Label sandbox behaviour and draft policies honestly.

## Testing

- Integration tests: `packages/application/test/<module>/*.test.ts` against real Postgres using fixtures in
  `test/support` (`createUser`, `createShop`, `createListing`, `ctxFor`, `systemCtx`, `testServices`).
  Each file ends with `afterAll(closeTestServices)`.
- Concurrency tests must use real overlapping transactions (`Promise.all` over `withTransaction`), not mocks.
- Inject time via `createUser({ now })` / `ctxFor(actor, now)` for expiry/auction tests.
- Before handing off: `pnpm typecheck`, relevant tests, and `pnpm --filter @thrift/web build` when web changed.
