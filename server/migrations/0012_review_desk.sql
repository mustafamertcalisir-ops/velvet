-- 0012 — The membership team's review desk and invited membership (DEC-087, DEC-088).
--
-- 1. application_access_log — who opened an application's private review view,
--    and when (internal review:read, GET /internal/reviewer/applications/:id).
--    Ids only: the application id and the principal ("<key id>:<reviewer id>").
--    Append-only like media_access_log; removed only by the retention process
--    under the audit window (docs/DATA_RETENTION.md).
--
-- 2. memberships.activation — how a membership is (to be) activated:
--      'billing'        a payment provider confirms (the default; every existing row);
--      'complimentary'  an invited membership started by the membership team
--                       (staging only, DEC-088). Never a payment: no billing event
--                       is recorded and nothing renews. granted_by names the
--                       reviewer who started it.

CREATE TABLE app.application_access_log (
  id              text PRIMARY KEY,
  application_id  text NOT NULL REFERENCES app.membership_applications (id),
  principal       text NOT NULL,
  purpose         text NOT NULL CHECK (purpose IN ('REVIEW')),
  created_at      timestamptz NOT NULL
);
CREATE INDEX application_access_log_app_idx ON app.application_access_log (application_id, created_at);
CREATE TRIGGER application_access_log_append_only BEFORE UPDATE OR DELETE ON app.application_access_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_append_only();
CREATE TRIGGER application_access_log_no_truncate BEFORE TRUNCATE ON app.application_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_events_append_only();

ALTER TABLE app.application_access_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.application_access_log TO velvet_runtime;
CREATE POLICY runtime_access ON app.application_access_log TO velvet_runtime USING (true) WITH CHECK (true);

ALTER TABLE app.memberships
  ADD COLUMN activation text NOT NULL DEFAULT 'billing' CHECK (activation IN ('billing', 'complimentary')),
  ADD COLUMN granted_by text,
  ADD CONSTRAINT memberships_complimentary_grant CHECK ((activation = 'complimentary') = (granted_by IS NOT NULL));
