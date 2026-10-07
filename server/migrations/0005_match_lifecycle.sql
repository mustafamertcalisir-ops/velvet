-- 0005 — Match lifecycle (DEC-060, revised).
--
-- Before: one match per pair, ever (UNIQUE pair_key).
-- Now:    at most ONE ACTIVE match per pair at a time; ended matches are kept
--         as auditable history (ENDED, BLOCKED). The lifetime uniqueness is
--         replaced by a partial unique index on ACTIVE rows, so simultaneous
--         mutual likes still produce exactly one active match.

ALTER TABLE app.matches ADD COLUMN status text;

UPDATE app.matches
   SET status = CASE
                  WHEN ended_at IS NULL THEN 'ACTIVE'
                  WHEN ended_reason = 'BLOCK' THEN 'BLOCKED'
                  ELSE 'ENDED'
                END;

ALTER TABLE app.matches ALTER COLUMN status SET NOT NULL;
ALTER TABLE app.matches ADD CONSTRAINT matches_status_check CHECK (status IN ('ACTIVE', 'ENDED', 'BLOCKED'));
-- ACTIVE ⇔ not ended; BLOCKED ⇔ ended by a block.
ALTER TABLE app.matches ADD CONSTRAINT matches_status_consistent CHECK (
  ((status = 'ACTIVE') = (ended_at IS NULL)) AND ((status = 'BLOCKED') = (ended_reason IS NOT DISTINCT FROM 'BLOCK'))
);

ALTER TABLE app.matches DROP CONSTRAINT matches_ended_reason_check;
ALTER TABLE app.matches ADD CONSTRAINT matches_ended_reason_check
  CHECK (ended_reason IN ('BLOCK', 'MEMBERSHIP_ENDED', 'UNMATCH', 'ACCOUNT_DELETED'));

-- One ACTIVE match per canonical pair — enforced by the database.
ALTER TABLE app.matches DROP CONSTRAINT matches_pair_key_key;
CREATE UNIQUE INDEX matches_one_active_per_pair ON app.matches (pair_key) WHERE status = 'ACTIVE';
-- Pair history ("when did this pair's last match end?").
CREATE INDEX matches_pair_history_idx ON app.matches (pair_key, ended_at);
-- A member's active matches (Messages, authorization).
CREATE INDEX matches_active_a_idx ON app.matches (member_a) WHERE status = 'ACTIVE';
CREATE INDEX matches_active_b_idx ON app.matches (member_b) WHERE status = 'ACTIVE';
