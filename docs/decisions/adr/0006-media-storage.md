# ADR-0006: Media pipeline — sniff, decode, strip metadata, re-encode; signed URLs for restricted media

Status: Accepted, 2026-10-12.

## Decision
- Uploads go to `POST /api/v1/media`. The server checks size, sniffs magic bytes (JPEG/PNG/WebP only), fully decodes with
  sharp (rejects malformed/polyglot files), auto-rotates, strips EXIF/GPS metadata and re-encodes WebP (q≈84,
  max 1600px) plus a 480px thumbnail. Quality is kept high enough to inspect flaws.
- Storage adapter: local disk in development, S3-compatible object storage + CDN in production (adapter boundary in
  `packages/providers/src/storage`).
- Restricted purposes (verification evidence, dispute evidence, delivery proof, chat photos) are only served with
  short-lived HMAC-signed URLs issued after an authorisation check; public listing photos are cacheable.
