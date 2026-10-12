# ADR-0003: Payment provider abstraction, sandbox default, Paystack disabled pending D04

Status: Accepted, 2026-10-12.

## Context
Paystack documents split payments, transaction verification and signed webhooks, but splits are not escrow, its
published business-eligibility pages conflict on escrow-style services, and preauthorisation is South-Africa-only
(plan S7–S12). Whether funds can be held and released on delivery for this business is unconfirmed.

## Decision
- `PaymentProvider` interface: initialize, verify, refund, transfer, verifyWebhookSignature, parseWebhook.
- `SandboxPaymentProvider` (default): deterministic, persisted in `sandbox_payments`, hosted page at
  `/sandbox/pay/[reference]`, HMAC-signed webhooks. The UI shows a sandbox banner everywhere.
- `PaystackPaymentProvider` implemented against public docs but not enabled; enabling requires D04 sign-off.
- The platform models obligations (seller payable held until delivery confirmation) in its own ledger and payout
  state machine. This does not claim the provider holds funds in escrow.

## Consequences
Real-money launch is blocked on D04 + legal review; all other flows are testable end to end.
