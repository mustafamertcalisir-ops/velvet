-- 0010 — Least-privilege runtime role (DEC-074).
--
-- Until now the API connected as the schema owner. From this migration on:
--   * the schema owner runs migrations only (MIGRATION_DATABASE_URL);
--   * the API connects as a LOGIN role that is a member of `velvet_runtime`
--     (created once per database server by the operator:
--     infra/postgres/create-runtime-login.sql). The API refuses to start in
--     staging/production as a superuser, a BYPASSRLS role or the owner.
--
-- `velvet_runtime` is a NOLOGIN group role. It gets:
--   * USAGE on schema app, and only data privileges on its tables — no DDL,
--     no TRUNCATE, no REFERENCES, no TRIGGER;
--   * no UPDATE on append-only logs (audit_events, media_access_log);
--   * read-only access to membership plans (operators manage plans);
--   * a row-level-security policy on every table (RLS is enabled on all of
--     them since 0004, with no policy: without this, a non-owner sees nothing);
--   * read access to the migration ledger (readiness checks the schema).
--
-- Every future migration that creates a table MUST grant it to
-- velvet_runtime and create its `runtime_access` policy in the same file.
-- server/test/roles.test.ts fails otherwise, and the whole test suite runs as
-- a runtime login role, so a missing grant is caught immediately.
--
-- Creating the group role needs CREATEROLE (or superuser). If the migration
-- role lacks it, this migration FAILS — the API is never silently left on the
-- owner role. Create the role first with a privileged account, then re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velvet_runtime') THEN
    CREATE ROLE velvet_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'velvet_runtime'
       AND (rolsuper OR rolcanlogin OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'role velvet_runtime exists with more than group privileges; refusing to grant it data access';
  END IF;
  -- It must inherit nothing: membership in the owner or in pg_*_all_data would bypass every grant below.
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'velvet_runtime') THEN
    RAISE EXCEPTION 'role velvet_runtime is a member of another role; refusing to grant it data access';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA app TO velvet_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO velvet_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO velvet_runtime;

-- Append-only logs: rows are added, never changed (deletion only by the retention process).
REVOKE UPDATE ON app.audit_events, app.media_access_log FROM velvet_runtime;
-- Plans are configuration, managed by operators with the owner role.
REVOKE INSERT, UPDATE, DELETE ON app.membership_plans FROM velvet_runtime;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('CREATE POLICY runtime_access ON app.%I TO velvet_runtime USING (true) WITH CHECK (true)', t.tablename);
  END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA app_meta TO velvet_runtime;
GRANT SELECT ON app_meta.schema_migrations TO velvet_runtime;
