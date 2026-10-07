-- 0007 — Direct-upload media pipeline (DEC-063, revised).
--
-- The client asks for an upload authorization, uploads straight to private
-- object storage (incoming/…), then asks the API to complete it. Only after
-- processing (content check, re-encode, metadata stripped) does a media row
-- exist. Uploads never completed expire and their incoming objects are removed.

CREATE TABLE app.media_uploads (
  id                      text PRIMARY KEY,
  account_id              text NOT NULL REFERENCES app.accounts (id),
  media_class             text NOT NULL CHECK (media_class IN ('APPLICATION_MEDIA', 'VERIFICATION_MEDIA', 'PROFILE_MEDIA')),
  request_id              text REFERENCES app.information_requests (id),
  declared_content_type   text NOT NULL CHECK (declared_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  declared_bytes          integer NOT NULL CHECK (declared_bytes > 0),
  incoming_key            text NOT NULL UNIQUE,
  status                  text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED', 'EXPIRED')),
  rejection_reason        text CHECK (rejection_reason IN ('NOT_AN_IMAGE', 'TOO_LARGE', 'MISSING', 'NOT_ALLOWED')),
  media_id                text,
  created_at              timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  completed_at            timestamptz,
  incoming_swept_at       timestamptz,   -- the incoming object was deleted after the url could no longer be used
  CHECK ((status = 'COMPLETED') = (media_id IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (rejection_reason IS NOT NULL)),
  CHECK (media_class <> 'PROFILE_MEDIA' OR request_id IS NULL)
);
CREATE INDEX media_uploads_pending_idx ON app.media_uploads (expires_at) WHERE status = 'PENDING';
CREATE INDEX media_uploads_account_idx ON app.media_uploads (account_id, created_at);

-- Media rows can outlive their bytes: purged_at marks objects deleted under
-- the retention policy (the row stays for history / references).
ALTER TABLE app.application_media ADD COLUMN purged_at timestamptz;
ALTER TABLE app.member_media ADD COLUMN removed_at timestamptz;   -- taken off the profile by the member
ALTER TABLE app.member_media ADD COLUMN purged_at timestamptz;
ALTER TABLE app.member_media ADD CONSTRAINT member_media_removed_position CHECK (removed_at IS NULL OR position = -1);
UPDATE app.member_media SET removed_at = created_at WHERE position < 0 AND removed_at IS NULL;

-- Who looked at the most private media, when, and why (reviewer access to
-- verification photos). Append-only like the audit log.
CREATE TABLE app.media_access_log (
  id             text PRIMARY KEY,
  media_id       text NOT NULL REFERENCES app.application_media (id),
  media_class    text NOT NULL CHECK (media_class IN ('APPLICATION_MEDIA', 'VERIFICATION_MEDIA', 'PROFILE_MEDIA')),
  principal      text NOT NULL,
  purpose        text NOT NULL CHECK (purpose IN ('REVIEW', 'SAFETY')),
  created_at     timestamptz NOT NULL
);
CREATE INDEX media_access_log_media_idx ON app.media_access_log (media_id, created_at);
CREATE TRIGGER media_access_log_append_only BEFORE UPDATE OR DELETE ON app.media_access_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_append_only();

ALTER TABLE app.media_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.media_access_log ENABLE ROW LEVEL SECURITY;
