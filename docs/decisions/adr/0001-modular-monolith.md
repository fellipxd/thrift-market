# ADR-0001: TypeScript modular monolith with a separate worker

Status: Accepted (engineering), 2026-10-12. Owner review pending (D03).

## Context
Payments, inventory allocation, offers and auctions must share one transactional authority. The team is small and
React/JavaScript-experienced. The plan recommends a modular monolith and warns against premature microservices.

## Decision
- One pnpm monorepo: `apps/web` (Next.js 16 App Router — storefront, seller workspace, admin, JSON API, webhooks),
  `apps/worker` (plain Node via tsx, no Next.js imports), shared packages `domain` (pure rules), `application`
  (use cases), `database`, `contracts` (zod), `providers` (adapters).
- Business rules live only in `domain`/`application`; web and worker are thin entry points.
- UI components live in `apps/web/src/components` instead of a separate `packages/ui`, because there is one UI app.
  Extract when a second client exists.

## Consequences
- No distributed transactions; one Postgres authority.
- Web and worker scale independently; worker tasks are idempotent scans safe to run on several instances.
- A future mobile client can use `/api/v1` with Bearer session tokens.
