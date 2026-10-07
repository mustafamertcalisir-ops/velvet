-- 0006 — Account lifecycle, session security, retention holds (DEC-066, DEC-067).
--
-- Account lifecycle:  active → deletion_requested → anonymized
--                     active ⇄ suspended
-- An anonymized account has no phone number: the number is free to sign up
-- again as a new person. Rows that other records point to (member profile,
-- matches, safety records) remain, without identifying data.

ALTER TABLE app.accounts DROP CONSTRAINT accounts_account_status_check;
ALTER TABLE app.accounts ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE app.accounts ALTER COLUMN phone_verified_at DROP NOT NULL;
ALTER TABLE app.accounts ADD COLUMN suspended_at timestamptz;
ALTER TABLE app.accounts ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE app.accounts ADD COLUMN anonymized_at timestamptz;
-- Existing rows: the old 'deleted' status becomes a pending deletion request, so the
-- retention process anonymizes it properly (private data, media, number released);
-- an existing suspension keeps its date as best known.
UPDATE app.accounts
   SET account_status = 'deletion_requested', deletion_requested_at = updated_at
 WHERE account_status = 'deleted';
UPDATE app.accounts SET suspended_at = updated_at WHERE account_status = 'suspended';
ALTER TABLE app.accounts ADD CONSTRAINT accounts_account_status_check
  CHECK (account_status IN ('active', 'suspended', 'deletion_requested', 'anonymized'));
ALTER TABLE app.accounts ADD CONSTRAINT accounts_phone_lifecycle CHECK ((account_status = 'anonymized') = (phone_e164 IS NULL));
ALTER TABLE app.accounts ADD CONSTRAINT accounts_lifecycle_dates CHECK (
  (account_status <> 'suspended' OR suspended_at IS NOT NULL) AND
  (account_status NOT IN ('deletion_requested', 'anonymized') OR deletion_requested_at IS NOT NULL) AND
  ((account_status = 'anonymized') = (anonymized_at IS NOT NULL))
);
CREATE INDEX accounts_deletion_queue_idx ON app.accounts (deletion_requested_at) WHERE account_status = 'deletion_requested';

-- Sessions: idle expiry, rotation with reuse detection, revocation reasons.
ALTER TABLE app.sessions ADD COLUMN family_id text;
UPDATE app.sessions SET family_id = token_hash WHERE family_id IS NULL;
ALTER TABLE app.sessions ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE app.sessions ADD COLUMN last_used_at timestamptz;
UPDATE app.sessions SET last_used_at = created_at WHERE last_used_at IS NULL;
ALTER TABLE app.sessions ALTER COLUMN last_used_at SET NOT NULL;
ALTER TABLE app.sessions ADD COLUMN replaced_by text;          -- hash of the token that replaced this one (rotation)
ALTER TABLE app.sessions ADD COLUMN revoked_reason text CHECK (revoked_reason IN
  ('SIGN_OUT', 'SIGN_OUT_ALL', 'ROTATED', 'REUSE_DETECTED', 'SUSPENDED', 'DELETION_REQUESTED', 'EXPIRED'));
-- Before this migration a session could only be revoked by signing out.
UPDATE app.sessions SET revoked_reason = 'SIGN_OUT' WHERE revoked_at IS NOT NULL AND revoked_reason IS NULL;
ALTER TABLE app.sessions ADD CONSTRAINT sessions_revocation_consistent CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL));
CREATE INDEX sessions_family_idx ON app.sessions (family_id);
CREATE INDEX sessions_live_by_account_idx ON app.sessions (account_id) WHERE revoked_at IS NULL;

-- One-time codes: cleanup and per-number windows.
CREATE INDEX otp_challenges_expiry_idx ON app.otp_challenges (expires_at);

-- Staging/test only: codes for designated TEST numbers, readable by the
-- authorised smoke-test principal. The API refuses to enable this in
-- production (config). Rows are deleted when read or expired.
CREATE TABLE app.sms_test_outbox (
  phone_e164   text PRIMARY KEY CHECK (phone_e164 ~ '^\+[0-9]{6,15}$'),
  code         text NOT NULL CHECK (code ~ '^[0-9]{6}$'),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL
);

-- Retention holds: a safety or legal reason to keep an account's records
-- beyond the normal deletion/anonymization path (DEC-067). Set and released
-- by internal tooling only; durations are policy, not code.
CREATE TABLE app.retention_holds (
  id            text PRIMARY KEY,
  account_id    text NOT NULL REFERENCES app.accounts (id),
  reason        text NOT NULL CHECK (reason IN ('SAFETY_REPORT', 'INVESTIGATION', 'LEGAL_REQUEST', 'OTHER')),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL,
  released_at   timestamptz,
  released_by   text,
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX retention_holds_active_idx ON app.retention_holds (account_id) WHERE released_at IS NULL;

-- Member profiles: anonymized at account deletion (kept for referential history).
ALTER TABLE app.member_profiles ADD COLUMN deleted_at timestamptz;
ALTER TABLE app.member_profiles ADD CONSTRAINT member_profiles_deleted_hidden CHECK (deleted_at IS NULL OR visibility = 'hidden');

ALTER TABLE app.sms_test_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.retention_holds ENABLE ROW LEVEL SECURITY;
