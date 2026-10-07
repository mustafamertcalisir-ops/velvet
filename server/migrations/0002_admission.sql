-- 0002 — Admission: applications, private application data, referrals,
-- application media, information requests, reviews, audit, memberships.
--
-- The lifecycle status is the ONE authoritative state (DEC-019); it changes
-- only through the API's lifecycle functions, which validate every
-- transition with the shared domain rules (src/domain/admission/status.ts).

CREATE TABLE app.membership_applications (
  id                              text PRIMARY KEY,
  account_id                      text NOT NULL UNIQUE REFERENCES app.accounts (id), -- one application per account
  status                          text NOT NULL CHECK (status IN (
                                    'APPLICATION_DRAFT', 'APPLICATION_SUBMITTED', 'APPLICATION_RECEIVED',
                                    'UNDER_REVIEW', 'EXTENDED_APPLICATION_REQUIRED', 'EXTENDED_APPLICATION_DRAFT',
                                    'EXTENDED_APPLICATION_SUBMITTED', 'FINAL_REVIEW', 'MORE_INFORMATION_REQUIRED',
                                    'WAITLISTED', 'APPROVED', 'NOT_ADMITTED', 'MEMBERSHIP_PAYMENT_REQUIRED',
                                    'ACTIVE_MEMBER', 'SUSPENDED', 'EXPIRED')),
  stage1_completed_at             timestamptz,
  submitted_at                    timestamptz,
  review_started_at               timestamptz,
  extended_requested_at           timestamptz,
  extended_submitted_at           timestamptz,
  final_review_started_at         timestamptz,
  decision_at                     timestamptz,
  more_information_requested_at   timestamptz,
  more_information_return_to      text CHECK (more_information_return_to IN ('UNDER_REVIEW', 'FINAL_REVIEW')),
  information_provided_at         timestamptz,
  reopened_at                     timestamptz,
  created_at                      timestamptz NOT NULL,
  updated_at                      timestamptz NOT NULL
);
CREATE INDEX membership_applications_status_idx ON app.membership_applications (status);

-- Private, review-only. Never sent to member clients; surname, date of birth,
-- Instagram, city answer and written answers live only here.
CREATE TABLE app.application_private_data (
  application_id         text PRIMARY KEY REFERENCES app.membership_applications (id),
  first_name             text NOT NULL,
  last_name              text NOT NULL,
  date_of_birth          date NOT NULL,
  instagram_handle       text NOT NULL,
  country_code           text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  city                   jsonb NOT NULL,
  referral_kind          text NOT NULL CHECK (referral_kind IN ('none', 'requested')),
  occupation             text,
  work_context           text,
  work_context_answer    jsonb,
  work_description       text,
  personal_response      text,
  interests              text[] NOT NULL DEFAULT '{}',
  intents                text[] NOT NULL DEFAULT '{}',
  education              text,
  website_url            text,
  portfolio_url          text,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL
);

-- Referral requests. Matched against members privately; the applicant is never told the outcome.
CREATE TABLE app.application_referrals (
  id                    text PRIMARY KEY,
  application_id        text NOT NULL REFERENCES app.membership_applications (id),
  referrer_name         text NOT NULL,
  referrer_phone_e164   text NOT NULL CHECK (referrer_phone_e164 ~ '^\+[0-9]{6,15}$'),
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'declined', 'expired')),
  requested_at          timestamptz NOT NULL
);
CREATE INDEX application_referrals_app_idx ON app.application_referrals (application_id);

-- Private matching answers from the extended application (DEC-040). Only with Dating.
CREATE TABLE app.application_dating_preferences (
  application_id   text PRIMARY KEY REFERENCES app.membership_applications (id),
  meet             text[] NOT NULL CHECK (cardinality(meet) > 0),
  age_min          integer NOT NULL,
  age_max          integer NOT NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CHECK (age_min >= 18 AND age_max <= 80 AND age_max > age_min)
);

-- Structured information requests (DEC-042). Narrow, preset-phrased.
CREATE TABLE app.information_requests (
  id               text PRIMARY KEY,
  application_id   text NOT NULL REFERENCES app.membership_applications (id),
  type             text NOT NULL CHECK (type IN ('REPLACE_PHOTO', 'VERIFY_IDENTITY', 'UPDATE_INSTAGRAM', 'CLARIFY_WORK', 'UPDATE_APPLICATION_FIELD')),
  explanation      text NOT NULL,
  ordinal          integer NOT NULL DEFAULT 0, -- order within the reviewer's round
  target           jsonb,
  status           text NOT NULL CHECK (status IN ('open', 'answered', 'resolved', 'withdrawn')),
  response         jsonb,
  created_at       timestamptz NOT NULL,
  answered_at      timestamptz,
  resolved_at      timestamptz
);
CREATE INDEX information_requests_app_idx ON app.information_requests (application_id, created_at);

-- Private application media. Bytes live in the private object store under
-- storage_key (re-encoded, metadata stripped); clients only ever receive
-- short-lived signed URLs. Verification media never joins a profile.
CREATE TABLE app.application_media (
  id                  text PRIMARY KEY,
  application_id      text NOT NULL REFERENCES app.membership_applications (id),
  type                text NOT NULL CHECK (type IN ('photo', 'video')),
  purpose             text NOT NULL CHECK (purpose IN ('profile', 'verification')),
  storage_key         text NOT NULL UNIQUE,
  content_type        text NOT NULL,
  width               integer NOT NULL CHECK (width > 0),
  height              integer NOT NULL CHECK (height > 0),
  bytes               integer NOT NULL CHECK (bytes > 0),
  position            integer NOT NULL DEFAULT -1,
  moderation_status   text NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  request_id          text REFERENCES app.information_requests (id),
  retired_at          timestamptz,
  created_at          timestamptz NOT NULL,
  CHECK (purpose = 'profile' OR position = -1)
);
CREATE INDEX application_media_app_idx ON app.application_media (application_id);

-- Internal reviewer actions, with internal reason codes. Never sent to applicants.
CREATE TABLE app.application_reviews (
  id              text PRIMARY KEY,
  application_id  text NOT NULL REFERENCES app.membership_applications (id),
  reviewer_id     text NOT NULL,
  action          text NOT NULL,
  from_status     text NOT NULL,
  to_status       text NOT NULL,
  reason_code     text CHECK (reason_code IN ('COMMUNITY_FIT', 'TRUST_REVIEW', 'APPLICATION_QUALITY', 'CAPACITY', 'SAFETY', 'OTHER')),
  request_types   text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL
);
CREATE INDEX application_reviews_app_idx ON app.application_reviews (application_id, created_at);

-- Audit: structured, append-only (enforced below). No free-text notes.
CREATE TABLE app.audit_events (
  id               text PRIMARY KEY,
  application_id   text,
  account_id       text,
  event_type       text NOT NULL,
  previous_status  text,
  new_status       text,
  actor_type       text NOT NULL CHECK (actor_type IN ('applicant', 'member', 'reviewer', 'system')),
  actor_id         text,
  reason_code      text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL
);
CREATE INDEX audit_events_account_idx ON app.audit_events (account_id, created_at);
CREATE INDEX audit_events_app_idx ON app.audit_events (application_id, created_at);

CREATE FUNCTION app.audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON app.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_events_append_only();

-- Membership plans (DEC-047: pricing not final). Migrations seed nothing;
-- a development seed adds a plan flagged as a development fixture.
CREATE TABLE app.membership_plans (
  id                       text PRIMARY KEY,
  name                     text NOT NULL,
  billing_period           text NOT NULL CHECK (billing_period IN ('monthly', 'annual')),
  price_minor              integer NOT NULL CHECK (price_minor >= 0),
  currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  is_development_fixture   boolean NOT NULL DEFAULT false,
  active                   boolean NOT NULL DEFAULT true
);

CREATE TABLE app.memberships (
  id           text PRIMARY KEY,
  account_id   text NOT NULL UNIQUE REFERENCES app.accounts (id),
  plan_id      text NOT NULL REFERENCES app.membership_plans (id),
  status       text NOT NULL CHECK (status IN ('pending', 'active', 'grace_period', 'cancelled', 'expired')),
  started_at   timestamptz,
  renews_at    timestamptz,
  ends_at      timestamptz,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);

-- Billing provider confirmations, recorded once (idempotent by provider event id).
CREATE TABLE app.billing_events (
  provider_event_id   text PRIMARY KEY,
  account_id          text NOT NULL REFERENCES app.accounts (id),
  kind                text NOT NULL CHECK (kind IN ('payment_confirmed', 'membership_expired')),
  provider            text NOT NULL,
  received_at         timestamptz NOT NULL
);
