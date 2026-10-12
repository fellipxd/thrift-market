# ADR-0005: First-party accounts with hashed session tokens and verified contacts

Status: Accepted, 2026-10-12.

## Decision
- One identity can buy and sell; seller capability = shop membership. Staff roles are separate grants
  (support, trust_safety, finance, admin) — no implicit superuser.
- Passwords: scrypt (N=16384, r=8, p=1). Sessions: random 256-bit tokens, only SHA-256 hashes stored, httpOnly
  SameSite=Lax cookies (Bearer header accepted for API clients). Account lockout after repeated failures.
- Contact verification by 6-digit code (hashed, 15-minute expiry, attempt limits). Messaging, offers, bids and checkout
  require a verified contact. In sandbox, the code is shown on screen with a "Sandbox delivery" label.
- Staff MFA is a launch-hardening requirement (stage 3) — tracked, not yet implemented.
