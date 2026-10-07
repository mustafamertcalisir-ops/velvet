-- 0003 — Member product: public member profiles, member media, private Dating
-- settings, introductions, reactions, matches, conversations, messages,
-- blocks and reports.
--
-- Member-to-member identifiers are member profile ids — never account ids.
-- Public profile data is separate from private application data (DEC-049);
-- age is derived from the private date of birth at read time, never stored.

CREATE TABLE app.member_profiles (
  id             text PRIMARY KEY,
  account_id     text NOT NULL UNIQUE REFERENCES app.accounts (id),
  display_name   text NOT NULL,
  occupation     text,
  city_label     text,
  bio            text,
  known_for      text,
  interests      text[] NOT NULL DEFAULT '{}',
  intents        text[] NOT NULL DEFAULT '{}' CHECK (intents <@ ARRAY['dating', 'friendship', 'community']::text[]),
  visibility     text NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'paused', 'hidden')),
  confirmed_at   timestamptz,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);

-- Profile media owned by the member. Promoted explicitly from approved
-- application photos at activation (copied to member storage keys — never
-- verification photos), or added as a member.
CREATE TABLE app.member_media (
  id                            text PRIMARY KEY,
  member_id                     text NOT NULL REFERENCES app.member_profiles (id),
  type                          text NOT NULL CHECK (type IN ('photo', 'video')),
  storage_key                   text NOT NULL UNIQUE,
  content_type                  text NOT NULL,
  width                         integer NOT NULL CHECK (width > 0),
  height                        integer NOT NULL CHECK (height > 0),
  position                      integer NOT NULL DEFAULT -1, -- -1: removed from the profile (kept)
  source_application_media_id   text REFERENCES app.application_media (id),
  created_at                    timestamptz NOT NULL
);
CREATE INDEX member_media_member_idx ON app.member_media (member_id, position);

-- Private Dating settings (DEC-058). Stated by the member; never inferred,
-- never part of any other member's response.
--   gender       how the member describes themselves
--   appears_as   the normalised categories the member is included under
--   seeking      the categories the member would like to meet ("Everyone" = all)
CREATE TABLE app.dating_settings (
  member_id            text PRIMARY KEY REFERENCES app.member_profiles (id),
  gender               text CHECK (gender IN ('WOMAN', 'MAN', 'NON_BINARY', 'SELF_DESCRIBED')),
  self_description     text CHECK (char_length(self_description) BETWEEN 1 AND 40),
  appears_as           text[] NOT NULL DEFAULT '{}' CHECK (appears_as <@ ARRAY['WOMAN', 'MAN', 'NON_BINARY']::text[]),
  seeking              text[] NOT NULL DEFAULT '{}' CHECK (seeking <@ ARRAY['WOMAN', 'MAN', 'NON_BINARY']::text[]),
  age_min              integer,
  age_max              integer,
  setup_completed_at   timestamptz,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  CHECK ((gender = 'SELF_DESCRIBED') = (self_description IS NOT NULL)),
  CHECK (gender IS NULL OR cardinality(appears_as) > 0),
  CHECK (gender IS NULL OR gender = 'SELF_DESCRIBED' OR appears_as = ARRAY[gender]),
  CHECK ((age_min IS NULL) = (age_max IS NULL)),
  CHECK (age_min IS NULL OR (age_min >= 18 AND age_max <= 80 AND age_max > age_min)),
  CHECK (setup_completed_at IS NULL OR (gender IS NOT NULL AND cardinality(seeking) > 0 AND age_min IS NOT NULL))
);

-- One batch per member per calendar day; never refilled.
CREATE TABLE app.introduction_batches (
  id           text PRIMARY KEY,
  member_id    text NOT NULL REFERENCES app.member_profiles (id),
  batch_date   date NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (member_id, batch_date)
);

-- One introduction: the unit a reaction answers.
CREATE TABLE app.introduction_entries (
  id             text PRIMARY KEY,
  batch_id       text NOT NULL REFERENCES app.introduction_batches (id),
  viewer_id      text NOT NULL REFERENCES app.member_profiles (id),
  candidate_id   text NOT NULL REFERENCES app.member_profiles (id),
  batch_date     date NOT NULL,
  position       integer NOT NULL CHECK (position >= 0),
  context        text NOT NULL CHECK (context IN ('DATING')),
  status         text NOT NULL CHECK (status IN ('PENDING', 'PASSED', 'LIKED', 'WITHDRAWN')),
  responded_at   timestamptz,
  created_at     timestamptz NOT NULL,
  UNIQUE (batch_id, candidate_id),
  CHECK (viewer_id <> candidate_id)
);
CREATE INDEX introduction_entries_viewer_idx ON app.introduction_entries (viewer_id, batch_date);
CREATE INDEX introduction_entries_candidate_idx ON app.introduction_entries (candidate_id);

-- One answer per introduction (the unique key is what makes retries safe).
CREATE TABLE app.reactions (
  id                text PRIMARY KEY,
  introduction_id   text NOT NULL UNIQUE REFERENCES app.introduction_entries (id),
  from_member_id    text NOT NULL REFERENCES app.member_profiles (id),
  to_member_id      text NOT NULL REFERENCES app.member_profiles (id),
  type              text NOT NULL CHECK (type IN ('LIKE', 'PASS')),
  created_at        timestamptz NOT NULL,
  CHECK (from_member_id <> to_member_id)
);
CREATE INDEX reactions_pair_idx ON app.reactions (from_member_id, to_member_id, type);
CREATE INDEX reactions_to_idx ON app.reactions (to_member_id, from_member_id) WHERE type = 'LIKE';

-- One match per pair, ever: the ordered pair key is unique at the database level.
CREATE TABLE app.matches (
  id             text PRIMARY KEY,
  member_a       text NOT NULL REFERENCES app.member_profiles (id),
  member_b       text NOT NULL REFERENCES app.member_profiles (id),
  pair_key       text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  ended_reason   text CHECK (ended_reason IN ('BLOCK', 'MEMBERSHIP_ENDED', 'UNMATCH')),
  CHECK (member_a < member_b),
  CHECK (pair_key = member_a || '|' || member_b),
  CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
CREATE INDEX matches_a_idx ON app.matches (member_a);
CREATE INDEX matches_b_idx ON app.matches (member_b);

-- Conversations exist only for matches (one per match).
CREATE TABLE app.conversations (
  id           text PRIMARY KEY,
  match_id     text NOT NULL UNIQUE REFERENCES app.matches (id),
  created_at   timestamptz NOT NULL,
  closed_at    timestamptz
);

CREATE TABLE app.conversation_participants (
  conversation_id   text NOT NULL REFERENCES app.conversations (id),
  member_id         text NOT NULL REFERENCES app.member_profiles (id),
  last_opened_at    timestamptz,
  PRIMARY KEY (conversation_id, member_id)
);
CREATE INDEX conversation_participants_member_idx ON app.conversation_participants (member_id);

-- Text only. A retried send with the same client message id is the same message.
CREATE TABLE app.messages (
  id                  text PRIMARY KEY,
  seq                 bigint GENERATED ALWAYS AS IDENTITY, -- stable order within one instant
  conversation_id     text NOT NULL REFERENCES app.conversations (id),
  sender_id           text NOT NULL REFERENCES app.member_profiles (id),
  body                text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  client_message_id   text NOT NULL CHECK (char_length(client_message_id) BETWEEN 1 AND 100),
  created_at          timestamptz NOT NULL,
  UNIQUE (conversation_id, sender_id, client_message_id)
);
CREATE INDEX messages_conversation_idx ON app.messages (conversation_id, created_at, seq);

-- Blocks are silent and permanent records (safety evidence is never deleted).
CREATE TABLE app.blocks (
  id           text PRIMARY KEY,
  blocker_id   text NOT NULL REFERENCES app.member_profiles (id),
  blocked_id   text NOT NULL REFERENCES app.member_profiles (id),
  created_at   timestamptz NOT NULL,
  UNIQUE (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON app.blocks (blocked_id);

-- Structured reports for the membership team (no moderation dashboard yet).
CREATE TABLE app.reports (
  id                text PRIMARY KEY,
  reporter_id       text NOT NULL REFERENCES app.member_profiles (id),
  reported_id       text NOT NULL REFERENCES app.member_profiles (id),
  reason            text NOT NULL CHECK (reason IN ('NOT_GENUINE', 'INAPPROPRIATE_PHOTOS', 'HARASSMENT', 'SAFETY_CONCERN', 'UNDER_18', 'OTHER')),
  context           text NOT NULL CHECK (context IN ('profile', 'conversation')),
  conversation_id   text REFERENCES app.conversations (id),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'closed')),
  created_at        timestamptz NOT NULL,
  CHECK (reporter_id <> reported_id)
);
CREATE INDEX reports_status_idx ON app.reports (status, created_at);

-- Safety records are kept: blocks, reports and messages cannot be deleted by the API role.
CREATE FUNCTION app.safety_records_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records are kept as safety evidence', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER blocks_keep BEFORE DELETE ON app.blocks FOR EACH ROW EXECUTE FUNCTION app.safety_records_keep();
CREATE TRIGGER reports_keep BEFORE DELETE ON app.reports FOR EACH ROW EXECUTE FUNCTION app.safety_records_keep();
CREATE TRIGGER messages_keep BEFORE DELETE ON app.messages FOR EACH ROW EXECUTE FUNCTION app.safety_records_keep();
