-- 0009 — Signed internal requests: replay protection (DEC-070).
--
-- Every internal request carries a single-use nonce per key. A nonce is
-- remembered for longer than the accepted timestamp window, so a captured
-- request can never be replayed; the retention process removes old rows.

CREATE TABLE app.internal_nonces (
  key_id    text NOT NULL CHECK (key_id ~ '^[a-z][a-z0-9-]{1,40}$'),
  nonce     text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  seen_at   timestamptz NOT NULL,
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX internal_nonces_seen_idx ON app.internal_nonces (seen_at);

ALTER TABLE app.internal_nonces ENABLE ROW LEVEL SECURITY;
