# Threat model (STRIDE-oriented, launch scope)

Scope: web app, JSON API, webhooks, worker, Postgres, object storage, provider adapters. Risk level L3.
This is a developer-authored model; an **independent security review is pending** (stage 3 gate).

| # | Threat | Asset / entry point | Controls in the build | Residual / follow-up |
| --- | --- | --- | --- | --- |
| 1 | Account takeover (credential stuffing, guessing) | /sign-in, sessions | scrypt hashes; per-IP and per-contact rate limits; lockout after 8 failures; session tokens hashed at rest; httpOnly SameSite=Lax cookies; Secure in production; staff tools require TOTP two-step verification (RFC 6238) confirmed on the session within 12 hours — secret encrypted at rest (AES-256-GCM), each code usable once, hashed single-use recovery codes, admin reset revokes the person's sessions | Breached-password check; device/session management UI; phishing-resistant second factor (WebAuthn) for staff |
| 2 | Broken object-level authorisation (cross-shop/order access) | All use cases, /api/v1, media, polling endpoints | Every use case checks ownership/participation; other users' objects return NOT_FOUND; restricted media needs short-lived HMAC URLs; tests per slice (T08) | Independent BOLA test pass across every endpoint |
| 3 | CSRF | Server actions, cookie-auth API | Next.js server-action origin checks; API rejects cross-site cookie mutations (Sec-Fetch-Site/Origin); SameSite=Lax | — |
| 4 | Webhook forgery / replay | /api/webhooks/* | HMAC verification on raw body; unique (provider, event) inbox; amounts re-verified with provider API before any state change; status guards make replays no-ops | Provider IP allow-listing where supported |
| 5 | Double sale / race conditions | Checkout, offers, auctions | Single inventory authority with row locks, CHECK constraints, unique partial indexes; concurrency tests T01/T02/T05 | Load test under contention (T17) |
| 6 | Payment uncertainty / late callbacks | Reservations, payments | Never free stock on timer alone; provider verification; payment_pending grace; automatic refund for late payments; one succeeded attempt per order (unique index) | Provider statement reconciliation job (needs D04 provider) |
| 7 | Financial tampering / staff abuse | Refunds, payouts, payout accounts | Append-only balanced ledger (trigger); four-eyes for staff-exception refunds (DB check + use case); payout account changes audited with cooling-off; role separation; setting, policy and role changes need a reason and are audited; staff can't change their own roles and the last admin can't be removed | Finance reconciliation runbook rehearsal |
| 8 | Payout beneficiary substitution | payout_accounts | Only last 4 digits stored; replacement creates a new row with cooling-off; audit; release requires verified account | Bank-name match via provider (D07) |
| 9 | Malicious uploads | /api/v1/media | Size cap, magic-byte sniffing, full decode with pixel limit, re-encode to WebP, metadata (GPS) stripped, served with nosniff and fixed content type | Malware scanning for non-image evidence (not accepted at launch) |
| 10 | Location privacy | Shops, nearby search, addresses | Public shop location at city/area precision; coordinates never sent to clients; distances rounded; buyer addresses visible to the seller only after payment | — |
| 11 | Fake reviews / reputation gaming | Reviews, reputation | One review per purchased order item; purchase + delivery required; sample-aware scoring; ads cannot affect trust | Fraud signals (linked accounts) |
| 12 | Shill / self bidding | Auctions | Shop members cannot bid; verified contact required; rate limits; bid history masked | Cross-account linkage detection |
| 13 | Reservation hoarding | Checkout, offers | Per-buyer active hold cap; short holds; rate limits | Abuse dashboards |
| 14 | Chat spam / harassment | Messaging | Rate limits, duplicate-message detection, block, report, moderation | Content classifiers |
| 15 | Counterfeit / stolen / prohibited goods | Listings | Seller terms; reporting; trust & safety removal with reasons; "verified" never means authentic | Category policy (D11) |
| 16 | Injection | All SQL | Parameterised queries only; zod validation | Static analysis in CI |
| 17 | XSS | User text | React escaping; no dangerouslySetInnerHTML for user content; CSP (script-src self + inline required by Next) | Nonce-based CSP |
| 18 | Clickjacking | All pages | frame-ancestors 'none', X-Frame-Options DENY | — |
| 19 | Secrets leakage | Env | .env gitignored; production refuses the dev APP_SECRET; Paystack key only server-side | Secret manager in deployment (D03) |
| 20 | Data subject rights vs financial records | Users, orders | Financial history retained; deletion marks user `deleted` | Retention schedule with legal (NDPC guidance) |
| 21 | Rate-limit evasion via spoofed client IP | Sign-up, sign-in, all per-IP limits | Per-IP limits read the first `X-Forwarded-For` address (then `X-Real-IP`) | **Deployment requirement:** run behind a reverse proxy/load balancer that overwrites (not appends to) `X-Forwarded-For`, otherwise clients can rotate the header to bypass per-IP limits. Per-account and per-contact limits still apply. |
| 22 | Dispute abuse (serial false claims, refund fraud) | Disputes | Reason-specific windows; evidence ownership checks; decisions against the immutable purchase snapshot; one appeal decided by a different staff member; refunds only through the payments module | Buyer dispute-rate signals; claims history on the staff view |
