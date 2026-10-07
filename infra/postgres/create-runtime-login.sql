-- Create the API's least-privilege login role (DEC-074). Run ONCE per
-- database server, AFTER the release migration step has created the
-- `velvet_runtime` group role (migration 0010). Connect as the schema owner
-- (the provider's default user) from inside the private network:
--
--   psql "$MIGRATION_DATABASE_URL" -v login=velvet_api -f infra/postgres/create-runtime-login.sql
--
-- The login is created WITHOUT a password. Set the password interactively
-- in the same psql session (or a new one):
--
--   \password velvet_api
--
-- psql hashes the password (SCRAM) on your machine before sending it. So the
-- password never appears in this repository, on a command line (`ps`), in
-- shell history, or in the server's statement log. Use a long random value,
-- e.g. `openssl rand -hex 32` (hex needs no URL-encoding). Then store
--   postgres://velvet_api:<password>@<internal host>:5432/<database>
-- as the API's DATABASE_URL secret — never as MIGRATION_DATABASE_URL.
--
-- To rotate: create a second login (e.g. -v login=velvet_api_2), switch
-- DATABASE_URL, redeploy, then DROP ROLE the old one.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velvet_runtime') THEN
    RAISE EXCEPTION 'velvet_runtime does not exist: run the release migration step first (migration 0010)';
  END IF;
END;
$$;

CREATE ROLE :"login" LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 40
  IN ROLE velvet_runtime;

-- The runtime role reaches only the app schema; nothing else in this database.
REVOKE CREATE ON SCHEMA public FROM :"login";

\echo 'Created the runtime login (no password yet). Now run:  \password' :login
