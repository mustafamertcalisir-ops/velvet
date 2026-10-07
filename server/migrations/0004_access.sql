-- 0004 — Access boundary (defense in depth).
--
-- Members and applicants never talk to the database: the API is the only
-- client and answers with explicit DTOs (docs/PRIVACY_BOUNDARIES.md). Even so,
-- no other role may read anything in `app`:
--   * the schema and its tables are closed to PUBLIC;
--   * row-level security is ENABLED on every table with NO policies, so any
--     role that is not the owner sees zero rows even if a grant slips in;
--   * hosted-Postgres client roles (e.g. Supabase `anon` / `authenticated`)
--     are explicitly revoked when they exist.
-- The API connects as the schema owner (RLS does not apply to owners unless
-- forced), so its own queries are unaffected.

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role_readonly'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
