-- 0700_staff_mfa.sql (slice H1: staff MFA)
-- TOTP second factor. users.mfa_secret (from 0001) holds the AES-256-GCM encrypted secret; enrolment completes when
-- mfa_enabled_at is set. mfa_last_step stores the last accepted TOTP time step (replay protection).
ALTER TABLE users ADD COLUMN mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_last_step bigint;

-- A session counts as MFA-verified for staff tools while mfa_verified_at is recent.
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
