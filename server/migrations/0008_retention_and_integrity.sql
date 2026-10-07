-- 0008 — Retention semantics and relational integrity (DEC-067).
--
-- Retention: safety records (blocks, reports, messages) and append-only logs
-- (audit_events, media_access_log) are no longer "never deletable". They are
-- protected from ordinary deletion, and can be deleted only by the retention
-- process, which marks its own transaction (SET LOCAL app.retention_purge =
-- 'on') and applies the documented policy (docs/DATA_RETENTION.md). UPDATE of
-- append-only logs stays forbidden; TRUNCATE is always forbidden.

CREATE OR REPLACE FUNCTION app.safety_records_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% records are safety evidence and are removed only by the retention process', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION app.audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

-- Introductions: an entry belongs to its batch's member and day.
ALTER TABLE app.introduction_batches ADD CONSTRAINT introduction_batches_identity_key UNIQUE (id, member_id, batch_date);
ALTER TABLE app.introduction_entries ADD CONSTRAINT introduction_entries_batch_identity_fkey
  FOREIGN KEY (batch_id, viewer_id, batch_date) REFERENCES app.introduction_batches (id, member_id, batch_date);

-- Reactions: the answering member is the introduction's viewer, about its candidate.
ALTER TABLE app.introduction_entries ADD CONSTRAINT introduction_entries_identity_key UNIQUE (id, viewer_id, candidate_id);
ALTER TABLE app.reactions ADD CONSTRAINT reactions_introduction_identity_fkey
  FOREIGN KEY (introduction_id, from_member_id, to_member_id) REFERENCES app.introduction_entries (id, viewer_id, candidate_id);

-- Messages: only a participant of the conversation can be a sender.
ALTER TABLE app.messages ADD CONSTRAINT messages_sender_participant_fkey
  FOREIGN KEY (conversation_id, sender_id) REFERENCES app.conversation_participants (conversation_id, member_id);

-- Reactions are read by (viewer → candidate) and (candidate → viewer, LIKE) — both indexed in 0003.
-- Blocks are read in both directions — indexed in 0003 (unique pair + blocked_id).
