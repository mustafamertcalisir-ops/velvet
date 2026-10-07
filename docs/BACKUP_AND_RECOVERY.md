# Backup and recovery

What must be recoverable, what the selected providers actually offer, and how
restores are tested. Providers: docs/INFRASTRUCTURE_DECISION.md (DEC-073).
Provider capabilities below were checked against their documentation on
2026-10-07. **No provider account exists yet:** nothing here has run against
a real backup. The restore procedure was rehearsed locally with a logical
dump (§4.2).

---

## 1. What must be backed up

| Asset | Where (staging) | Backup |
|---|---|---|
| PostgreSQL (`app`, `app_meta`) | Render Postgres 16, `0.5c-1g`, Frankfurt | Render's continuous backups with point-in-time recovery (§2), plus a logical export before every release that carries a migration |
| Media bucket | AWS S3 eu-central-1 | **none** (§3) |
| Verification bucket | AWS S3 eu-central-1 | **none** (§3) |
| S3 server access logs | log bucket | the log bucket itself (lifecycle to be set with the retention policy) |
| Configuration | infra/render/render.yaml, infra/aws/, .github/workflows/ | the repository |
| Secrets | Render env vars, GitHub Environment, AWS IAM | never in any backup; regenerate on loss (§5) |

Not backed up on purpose:
- logs beyond the platform's retention (they contain no personal data,
  DEC-069; Render keeps them 14 days on Pro);
- test outboxes;
- the staging tools' state files.

## 2. What Render Postgres actually offers

The source for this section is https://render.com/docs/postgresql-backups.
- **Continuous backups and PITR.** Paid instances are backed up continuously
  for point-in-time recovery: **7 days** on a Pro workspace, 3 days on Hobby.
  The window does not backfill when you upgrade. The Free plan has no
  recovery.
- **A recovery always creates a NEW instance.** It never overwrites the
  original. You validate the new instance, then repoint services to it. A
  recovery target must be at least 10 minutes in the past. The recovery
  instance copies the original's IP allow list, which is empty for staging.
- **Logical exports.** On demand from the dashboard, kept **7 days**,
  downloadable as `.dir.tar.gz`, restorable with `pg_restore`.
- **`pg_dump` and schemas.** Render's examples use `-n public`. This schema
  lives in **`app` and `app_meta`**, so dumps must use `-n app -n app_meta`,
  or no `-n` at all.
- **Access.** With external access disabled, `pg_dump`/`pg_restore` run from
  inside the workspace (a one-off job or shell), or you temporarily
  allow-list one address for the restore test and remove it afterwards.
- **Not stated by Render** (NOT CONFIRMED): whether automatic daily logical
  backups exist beyond PITR; RPO/RTO figures.

## 3. Object storage is not backed up (deliberately, for now)

- **Versioning is off on purpose.** Turning it on would keep every deleted
  photo as a non-current version. That would defeat account deletion and
  purge windows unless non-current versions expire, and that expiry is a
  retention-policy decision that has not been made.
- **Consequence:** a lost or wrongly deleted object cannot be restored.
  Photos can be re-requested from the member (REPLACE_PHOTO); verification
  photos can be re-requested (VERIFY_IDENTITY).
- **To revisit** together with the retention policy: versioning with
  non-current expiration, or replication to a second bucket with the same
  deletion rules.

## 4. Restore testing

### 4.1 On staging (BLOCKED until the Render account exists)
Never restore over the active staging database.

**Automated:** Actions → `staging-checks` → `restore-drill` (typed
confirmation; server/scripts/render-ops.mjs, DEC-082) performs the steps below
through the Render API (`POST /v1/postgres/{id}/recovery`): live counts at the
start; recovery to a time ≥ 10 minutes back into a NEW instance in the same
environment; the time to *available* (RTO) recorded; only the runner's own
address allowed on the **recovery** instance (the live instance is never
touched); `migrate --verify` and row counts against it; the copy must end at
the target time (its last audit event ≤ the target); the recovery instance is
deleted — only if its id differs from the live one and its name carries the
drill prefix. The manual procedure:

1. Note the time T and row counts (accounts, applications, messages, audit
   events). Run a QA write to have something after T.
2. Render dashboard → `velvet-db-staging` → Recovery → Point-in-Time
   Recovery → restore to T into a **new** instance
   `velvet-db-staging-restore-<date>`, with the same plan. Wait for
   *Available*.
3. From inside the workspace, against the recovery instance:
   `MIGRATION_DATABASE_URL=<recovery internal URL> node dist/migrate.mjs --verify`.
   It must report the schema verified, with nothing pending or unknown.
4. Compare row counts with T. The QA write made after T must be absent.
5. Optionally: run a second API service, pointed at the recovery instance as
   its runtime login, with no traffic. Check `/health/ready` and run the
   smoke flow against it.
6. Record the measured restore time (RTO) and the data-loss window (RPO).
7. **Delete the recovery instance.** It is billed while it exists.

### 4.2 Logical dump and restore (rehearsed locally on every rehearsal run)
scripts/rehearse-staging.mjs:
1. Run `pg_dump -n app -n app_meta --format=custom --no-owner` from the
   rehearsal database (over TLS, as the owner).
2. Create a separate database and run `pg_restore` into it.
3. Run `migrate --verify` against the restored copy.
4. Compare the counts of accounts, messages and audit events.

Result: the restored schema verifies and the counts match. This proves the
procedure and the schema flags, **not** Render's PITR.

## 5. Secrets and backups
- Backups hold hashes, not secrets: session tokens are SHA-256 and codes are
  HMAC.
- Restoring without `OTP_SECRET` only invalidates pending codes (10
  minutes). A new `MEDIA_SIGNING_SECRET` only invalidates local-driver URLs.
- If a backup may be exposed:
  - revoke all sessions;
  - rotate every internal key, the runtime login (create a new login, then
    drop the old) and the Netgsm sub-user password;
  - treat it as a personal-data incident.

## 6. Backups and retention
- Deletion and anonymization act on the live system. Backups taken before an
  anonymization keep the data until they age out: **7 days** for PITR and
  for exports.
- **A restore must be followed by a retention run**, so that any deletion
  requested before the restore point but not yet processed is processed
  again.
- **Deletions processed after the restore point are lost** with the restore.
  The audit trail of the original instance is the record. That process
  (re-applying them) is not yet defined.
- Holds and audit events are restored with the database.

## 7. Backups and migrations
- Before a release that carries a migration, take a dashboard logical export
  (or note the PITR timestamp).
- Migrations are forward-only. A regretted migration is undone by PITR into
  a new instance plus a redeploy of the matching build, never by a down
  script.
- A restored database carries its own migration ledger. The API refuses to
  start on a mismatch.

## 8. Open items
- RPO/RTO targets, to be set after the first real restore test (§4.1).
- Object-storage protection consistent with the retention policy (§3).
- Re-applying deletions after a restore (§6).
- A scheduled logical export to S3 for longer retention (Render documents a
  cron recipe), if 7 days is not enough.
