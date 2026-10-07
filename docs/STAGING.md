# Staging

How the staging environment is built, released, exercised and checked.

- **Decisions:** DEC-068, DEC-073 to DEC-080.
- **Providers:** docs/INFRASTRUCTURE_DECISION.md.
- **Latest results, item by item:** docs/STAGING_REPORT.md.

> **Status: NOT DEPLOYED.** No account exists yet at Render, AWS, Netgsm or
> GitHub Actions for this project (§7 lists what the owner must create).
> Everything provider-side below is configuration that is ready to apply:
> infra/render/render.yaml, infra/aws/, .github/workflows/staging.yml.
>
> What has actually run is the **local staging-shaped rehearsal** (§6). It
> starts the production build of the API with staging configuration, on this
> machine, and runs every deployed-staging tool against it. The rehearsal is
> not a deployment and is never reported as one.

---

## 1. Environments

| | development | test | staging | production |
|---|---|---|---|---|
| Purpose | a laptop | automated tests, E2E | production-shaped, QA accounts and invited testers | members (later phase) |
| Hosting | local | local | Render web service, Frankfurt, staging workspace | its own Render workspace (not created) |
| Database | local / ephemeral | ephemeral PG 16 | Render Postgres 16, private only, TLS | its own instance |
| Storage | local disk | local disk / s3rver | AWS S3 eu-central-1: media, verification and log buckets | its own buckets and role |
| SMS | console / outbox file | capture / outbox file | Netgsm OTP (staging sub-user); designated test numbers → internal outbox | Netgsm (its own sub-user); no test numbers |
| Migrations | at start | at start | Render `preDeployCommand` (release step) | the same |
| DB role of the API | owner | runtime login | runtime login (`velvet_runtime`) | runtime login |
| Internal keys | dev key | test keys | runner (`test:otp test:review`), ops (`retention:run media:reconcile`) | no `test:*` scope accepted |
| App build | dev / mock | QA web build | release build, staging channel + app id (DEC-078) | release build, store |

`APP_ENV` selects the environment. Configuration comes only from the
environment and is validated at start (server/src/config.ts). Staging and
production refuse:
- anything development-shaped;
- an unencrypted database connection;
- the migration credential as the API credential.

In addition:
- In staging and production the API refuses to run as a superuser, a
  BYPASSRLS role or the schema owner (DEC-074).
- Production additionally refuses test numbers and every `test:*` scope.

## 2. Architecture

```
 app (staging build: app.velvet.membership.staging, EXPO_PUBLIC_API_URL=https://api-staging.<domain>)
        │ https (Render-managed certificate)
        ▼
 Render router (TLS, X-Forwarded-For)                                 TRUST_PROXY_HOPS=1
        │
        ▼
 velvet-api-staging   node dist/main.mjs   /health/live  /health/ready (gates traffic)
        │ private network, TLS          │ OIDC → STS (no stored keys)          │ https, Basic auth
        ▼                               ▼                                      ▼
 velvet-db-staging (PG 16)       S3 eu-central-1                       Netgsm /sms/rest/v2/otp
 ipAllowList: [] (no external)   media · verification (strict) · logs  staging API sub-user
        ▲
 velvet-ops-staging (Render cron, hourly) ── signed internal call ──▶ /internal/retention/run
 CI runner / operator tools ── signed, staging-bound requests ──▶ /internal/test/*  (QA accounts only)
```

## 3. Release workflow

```
CI verify ─▶ deploy hook (this commit) ─▶ Render build ─▶ preDeployCommand: node dist/migrate.mjs
          ─▶ new instance /health/ready = 200 ─▶ traffic moves ─▶ smoke ─▶ suites ─▶ redeploy ─▶ suites (after restart)
```

1. **CI** (.github/workflows/staging.yml):
   - typecheck, lint, tests;
   - server tests on real PostgreSQL;
   - build;
   - secret scan of the tree and history;
   - the full staging-shaped rehearsal (§6);
   - the release-bundle gate for the staging channel.
2. **Deploy:** `server/scripts/deploy-staging.mjs` calls the deploy hook with
   `ref=<sha>` and follows the deploy to `live` through the Render API.
3. **Release step:**
   - Render runs `node dist/migrate.mjs` as the **schema owner**
     (`MIGRATION_DATABASE_URL`) on a separate instance, before the new
     version starts.
   - It runs each migration once, in order, inside one transaction per
     file, under an advisory lock, and refuses a changed checksum. It ends
     with a schema verification.
   - A failure fails the deploy and the previous version keeps serving.
4. **Start:** the API (runtime login) checks its role and the schema and
   refuses to start on a mismatch.
5. **Smoke and suites** (§5, §8).

### Migration rules and rollback limitations
- **Forward-only.** Migrations are forward-only SQL. There are no automatic
  down migrations, and data transformations (0005 backfill, 0006 status
  rewrite) cannot be undone without a backup.
- **Expand, migrate, contract.** A release whose migration is not backward
  compatible cannot be rolled back by redeploying the old image: the old
  build refuses an unknown migration. Rolling back means point-in-time
  recovery into a new instance (docs/BACKUP_AND_RECOVERY.md) and repointing
  the service.
- **New tables** must `GRANT` to `velvet_runtime` and `CREATE POLICY
  runtime_access`, as in 0010. server/test/roles.test.ts fails otherwise.
- **No manual patches.** Never edit the database by hand after a release. A
  correction is a new migration.

## 4. Staging data and operations

- **Membership plan.** The release step creates `plan_staging` (fixture-flagged)
  in staging only (DEC-081). Nobody inserts it by hand; production never gets
  one this way.
- **Runtime login (DEC-081).** Render generates `DATABASE_RUNTIME_PASSWORD`.
  Every release step creates or re-asserts `velvet_api` (group
  `velvet_runtime` only) and sets its password as a SCRAM verifier computed in
  the release step, so the server never receives the plaintext. The API
  derives its connection from the owner's internal URL with that login.
  Rotation: regenerate the value in Render and redeploy.
  - Manual alternative (a host without generated values): `psql
    "$MIGRATION_DATABASE_URL" -v login=velvet_api -f
    infra/postgres/create-runtime-login.sql`, then `\password velvet_api`, then
    an explicit `DATABASE_URL`.
- **QA accounts (DEC-076).** These are accounts on designated test numbers
  (`SMS_TEST_NUMBERS=+90555000*`). Their codes go to the internal test
  outbox, never to a phone. They are marked `qa_account` and never meet
  non-QA members.

  `node dist/qa-seed.mjs` manages a fixed set (16 numbers) covering every
  applicant status and a small community: a compatible Dating pair, a man
  seeking men (incompatible gender), a woman outside the other's age range
  (incompatible age), a blocked pair, a matched pair with its conversation,
  and a non-Dating member:
  - `seed` creates or resumes the set; it is repeatable.
  - `list` prints the QA numbers.
  - `otp <number>` prints the code after a tester requested one on a
    device.
  - `remove` asks for deletion of the whole set.
- **Scheduled operations.** The Render cron `velvet-ops-staging` runs
  `node dist/ops.mjs retention` hourly: housekeeping, the deletion queue,
  and purge windows (all unset). A media reconciliation dry run can be
  scheduled the same way: `node dist/ops.mjs reconcile`.
- **Retention windows.** Leave every `RETENTION_*_DAYS` unset until the
  policy is decided. The dry run shows them as `null`.
- **QA age bands.** Each tool's Dating members sit in their own ages, with
  one-year ranges, so tools are never introduced to each other: suite 18–23,
  smoke 30–39, race 40–63, deletion 64–67, QA seed 70–79.

## 5. Smoke flow

`node dist/smoke.mjs` (environment: scripts/lib/staging.ts) runs 23
black-box checks over HTTP with QA accounts:
- health;
- the OTP boundary and sessions;
- Stage 1 and Stage 2 with direct uploads;
- the review fixture;
- the membership guard and media classes;
- activation through the fixture;
- Dating introductions;
- public/private DTO isolation;
- signed photo delivery;
- the mutual match and idempotent replay;
- conversation authorization;
- block.

It refuses to start unless `STAGING_ENVIRONMENT=staging`. It cannot work
against production: staging-bound signatures, test-only scopes, routes
absent there.

## 6. Local staging-shaped rehearsal (what has actually run)

`npm --prefix server run rehearse:staging` builds the API and runs
scripts/rehearse-staging.mjs. **Last result (2026-10-07): 57/57 steps.**
Within those, the tools themselves reported:
- smoke 23/23;
- suites 48/48 before the restart (including the proxy-hop check) and 7/7
  after; race 15/15; deletion 10/10;
- QA seed twice (repeatable, with its community checks);
- the owner's review tool (`dist/velvet-review.mjs`, §7.1) as a separate
  process: queue, application view, photo links (each served the image),
  a confirmed decision, an invited membership, refusals (wrong key, the
  runner's key, a non-staging API) — 9 steps;
- log review over 1883 lines with 119 canary values: 0 findings.

Every tool ran its signed staging preflight (`/internal/test/client-address`)
before its first OTP request.

**Setup**
- **PostgreSQL 16:** TLS required (self-signed), SCRAM passwords, plain TCP
  rejected; a non-superuser owner with CREATEROLE, like a managed provider's
  default user.
- **Storage:** s3rver, an S3 emulator. It does **not** validate signatures.
- **SMS:** `SMS_PROVIDER=none` plus test numbers.
- **Keys:** a runner key, an ops key and a reviewer key.
- **Proxy:** `TRUST_PROXY_HOPS=1`.

**Verified**
- **Configuration refusals:** before migration; development-shaped config;
  TLS off; plain TCP rejected by the database; the migration credential as
  the API's; the owner role as the API's.
- **Release step:** 0001→0012 applied by the non-superuser owner over TLS;
  checksum verification; schema facts (active-match index, audit,
  retention, session and media tables, RLS on every table, protective
  triggers, the session constraint).
- **Runtime role:** login created with the documented psql script; every
  API connection uses the runtime login over TLS.
- **Tools:** smoke; staging suites before and after an API restart; QA seed
  twice (repeatable); refusal outside `STAGING_ENVIRONMENT=staging`; the
  owner's review tool end to end, with the database confirming the invited
  membership (complimentary, granted by the reviewer, no billing event, no
  renewal, profile provisioned) and every open logged.
- **Operations:** the ops tool; retention dry run, then the real run, then a
  repeat run; media reconciliation.
- **Faults:**
  - Database down: ready 503, typed errors, liveness up, recovery without a
    restart.
  - Storage down: ready 503, then recovery.
- **Backup:** logical backup restored into an isolated database, schema
  verified, row counts equal.
- **Log review:** the canary log review; structured JSON; request ids.

**What it cannot show**
- Real S3 signature enforcement, CORS and IAM (§8.3).
- Real SMS delivery (§8.2).
- Render's router and its `X-Forwarded-For`, which is NOT CONFIRMED (§8.1).
- The managed database's backups (docs/BACKUP_AND_RECOVERY.md).
- More than one API instance.
- Devices (docs/DEVICE_QA_REPORT.md).

## 7. To deploy staging (order)

Each step says who acts. "Owner" steps happen in a provider's dashboard; no
secret is ever pasted into chat (DEC-081: almost every secret is generated by
the platform). Identifiers (tea-…, evm-…, srv-…, dpg-…, bucket names, role
ARNs) are not secrets.

| # | Who | Step |
|---|---|---|
| 1 | Owner | GitHub: a **private** repository, default branch `main`; allow the Claude GitHub connection to access it. |
| 2 | Claude | Push the repository. CI `verify` runs; the deploy jobs stop at "not configured". |
| 3 | Owner | Render: a **Pro** workspace used only for staging; connect GitHub; **New → Blueprint** → this repository, file `infra/render/render.yaml`. Enter the `sync: false` values: `SMS_PROVIDER=none`; leave the S3/AWS/Netgsm values empty for now; `PUBLIC_BASE_URL` and the cron's `OPS_API_URL` can be filled after step 4. |
| 4 | Render | Creates the database and the services and deploys once. The release step runs **0001→0012 on the empty database**, creates the runtime login and the staging plan. The API itself will not start yet (no storage) — expected. |
| 5 | Owner | Tell Claude: workspace `tea-…`, environment `evm-…`, service `srv-…`, database `dpg-…`, the service's `https://…onrender.com` address. Set `PUBLIC_BASE_URL` and the cron's `OPS_API_URL` to that address. |
| 6 | Owner | AWS (a staging account, `eu-central-1`, billing alarm on): IAM → Identity providers → add `https://oidc.render.com/<tea-id>` and `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com` for both. |
| 7 | Claude → Owner | Claude generates the CloudFormation template (`node infra/aws/staging-stack.mjs …`); the owner creates the stack from it in the CloudFormation console. Outputs: bucket names and two role ARNs. |
| 8 | Owner | Render: set `S3_BUCKET`, `S3_VERIFICATION_BUCKET`, `AWS_ROLE_ARN` from the outputs. GitHub Environment `staging`: variables `STAGING_API_URL`, `STAGING_KEY_ID=runner`, `STAGING_PHONE_PREFIX=+90555000`, `RENDER_SERVICE_ID`, `RENDER_OWNER_ID`, `RENDER_POSTGRES_ID`, `AWS_STORAGE_TEST_ROLE_ARN`, `S3_BUCKET`, `S3_VERIFICATION_BUCKET`; secrets `RENDER_DEPLOY_HOOK_URL` (service → Settings → Deploy Hook), `RENDER_API_KEY` (Account settings → API keys), `STAGING_KEY_SECRET` (copy `INTERNAL_KEY_RUNNER_SECRET` from the service's Environment page). |
| 9 | CI | Re-run `staging` on `main`: deploy, schema check inside Render, smoke, suites + database assertions, redeploy (the existing-schema release step), log review; then the `race` and `deletion` jobs. |
| 10 | CI | `staging-checks`: `storage` (real S3 + real browser upload), `seed`, `reconcile`, then the drills (`fault-drill`, `restore-drill`) — each drill asks for its name as confirmation. |
| 11 | Owner | İleti Merkezi (DEC-085; no company needed): individual account, API access on, a sender name approved. Render: `SMS_PROVIDER=iletimerkezi`, `ILETIMERKEZI_API_KEY`, `ILETIMERKEZI_API_HASH`, `ILETIMERKEZI_SENDER`, and `SMS_QA_REAL_NUMBERS` = the two project SIMs. GitHub secrets `STAGING_REAL_PHONE`, `STAGING_REAL_PHONE_2`. Redeploy. (Netgsm instead, once a company exists.) |
| 12 | Owner (laptop) | `node server/dist/staging-otp-check.mjs --with-limits` (then `--with-expiry`) with the SIMs; then `staging-checks → log-review` for that window, and `sms-outage-drill`. |
| 13 | Owner + Render | The web link (DEC-086): the Blueprint's `velvet-web-staging` static site — set its `EXPO_PUBLIC_API_URL` to the API address, the API's `CORS_ORIGINS` to the web address, and regenerate the storage stack with `--web-origin <web address>`. The build runs the staging release gate. |
| 13a | Owner | Expo: `eas init` once; in the EAS **preview** environment, `EXPO_PUBLIC_API_URL` = the API address (plain text). Android: `eas build --profile staging`. iPhone (after the individual Apple Developer membership): `eas build -p ios --profile testflight --auto-submit` from your own computer (Apple sign-in), then in App Store Connect → TestFlight: an external group, the beta information, and a **public link** once Apple's beta review passes. `scripts/check-build-env.mjs` refuses a staging build that does not point at the staging API. |
| 13b | Owner (computer) | The review tool (§7.1): install Node 22 LTS; `node velvet-review.mjs kur` — the API address, your reviewer name, and the key copied from the service's Environment page (`INTERNAL_KEY_REVIEWER_SECRET`), typed hidden. Never into chat. |
| 14 | Owner (phones) | The real journey (§8.4), deletion in the app, the device and screen-reader protocols (docs/DEVICE_QA_REPORT.md, docs/SCREEN_READER_QA_REPORT.md). |

### 7.1 Deciding invited testers' applications (DEC-087, DEC-088)

The owner decides, from their own computer, with `velvet-review.mjs` (built
as `server/dist/velvet-review.mjs`; one file, plain Node 22, no packages).

| Command | What it does |
|---|---|
| `node velvet-review.mjs` | Interactive: the queue (decide · start membership · waiting on the applicant), pick a number, read the application, open photos, decide. After an approval it offers to start the invited membership. |
| `kur` | First-time setup: API address, reviewer name (appears in the records), the key (hidden). Checks the key against the API before saving `~/.velvet-review.json` (0600). |
| `liste [--hepsi] [--qa]` | The queue; `--hepsi` adds decided ones, `--qa` the QA set. |
| `goster <no>` · `foto <no> [--kimlik] [--baglanti]` | The application; its photos in the browser (or printed links). Every open is logged on the server. |
| `karar <no> <EYLEM> … --evet` | A reviewer action (START_REVIEW, REQUEST_EXTENDED, REQUEST_INFORMATION, APPROVE, WAITLIST, NOT_ADMIT, REOPEN), optional internal reason. |
| `uyelik <no> --evet` | Starts the invited (complimentary) membership: ACTIVE_MEMBER, no payment recorded, nothing renews. |

What the friend sees: Stage 1 → "Application received" → (owner: START_REVIEW,
REQUEST_EXTENDED) → Stage 2 → final review → (owner: APPROVE, then the
invited membership) → the member product, where Membership reads "Invited
membership — there is nothing to pay". If the friend taps Continue on the
approval screen first, the membership screen shows activation as not yet
open until the owner starts the invited membership; either order works.

The tool shows personal data on the owner's screen only; it stores no
names, answers or photos. It refuses any API that is not https staging, and
its requests are signed for staging (a production API refuses them).

## 8. Deployed-staging checks

### 8.1 Suites (`node dist/staging-suite.mjs before-restart | after-restart | cleanup`)
These run against the deployed API with QA accounts only.

**Sessions**
- phone → OTP → session → rotation → the rotated token works → sign-out →
  both tokens refused;
- two sessions → sign out everywhere → both refused;
- a deletion request → the session is refused immediately.

**Enumeration**
- existing and new numbers: same status and fields;
- the same wrong-code answer;
- the timing gap is measured.

**Matching**
- A sees B; A likes, no match; B sees A; B likes, exactly one match;
- both open the same conversation;
- retried likes leave one match and one conversation entry.

**LIKE/BLOCK** (before-restart: one simultaneous round; the `race` phase:
both orders forced, then `STAGING_RACE_ROUNDS` simultaneous rounds, default 6)
- Like committed first, then the block: the match becomes BLOCKED, no message
  either way, no introduction either way, and the blocked member's view of
  the blocker is exactly the answer for an unknown member.
- Block committed first, then the like that would have matched: no match row,
  a generic answer.
- Simultaneous: whichever lands first, the block wins; the tool reports how
  often each order won.

**Account deletion** (the `deletion` phase) against a live match and
conversation: the session and member access die at once; the other member
gets the generic "unavailable"; the match and conversation end; the
activation (payment-confirmed) path cannot bring the account back.

**Internal routes on the deployment**: unsigned, a member token, a stale
signature, a signature for another environment, a replayed nonce, a changed
body and a key without the scope are all refused.

**Messaging**
- A matched member can send; a retried send does not duplicate.
- A non-matched member cannot send.
- After the restart: messages persist; blocked members, on both sides,
  cannot write to the closed conversation.

**Media through the real storage**
- A stored photo carries no EXIF or GPS.
- A verification photo uploads.
- No applicant or member response carries a verification URL.

**Errors and request ids**
- Typed, safe errors: malformed JSON, oversized body (413, connection
  closed), no session, unknown session, unknown member, invalid code.
- A client request id is kept end to end; a malformed one is replaced.
- A number with no SMS route gets the safe "couldn't send" copy.

**Rate limits**
- Messages per minute; reaction replay; media authorizations; OTP resend
  cooldown; reports per day.
- After the restart, the media and report limits still hold: they are
  stored in PostgreSQL.

**Health**
- Live and ready, with no infrastructure detail.

**Proxy.** `TRUST_PROXY_HOPS=1` assumes Render appends the client address to
`X-Forwarded-For`. Render's docs do not state it (NOT CONFIRMED), and
community reports differ. The first suite check settles it on the real
deployment:
- It sends a spoofed `X-Forwarded-For` to `/internal/test/client-address`
  (test-only).
- It requires the API to resolve neither the spoofed value nor a private
  (proxy) address.
- If it fails, adjust `TRUST_PROXY_HOPS` before relying on per-address
  limits or on `INTERNAL_ALLOWED_CIDRS`.

The same route is the tools' preflight: no tool sends a code request before
a signed, staging-only call succeeds. The rehearsal simulates the client
address with `STAGING_SIMULATED_CLIENT_IP`, which changes nothing on a real
deployment.

### 8.2 Real SMS (`node dist/staging-otp-check.mjs [--with-limits] [--with-expiry]`)
This check is operator-assisted, on the operator's own machine, with
**project-owned SIMs** (`STAGING_REAL_PHONE`, optional `STAGING_REAL_PHONE_2`
with no account). It needs no key. It checks:
- the request and its delivery (timed);
- a wrong code fails; the correct code succeeds; a reused code fails;
- the resend cooldown; after a resend, the earlier code is dead;
- five wrong codes lock the challenge;
- an existing and an unknown number get identical answers (SIM 2);
- with `--with-limits`, the hourly per-number cap refuses further sends;
- with `--with-expiry`, an expired code fails.

Codes exist only on the phones: the tool never prints or stores them. Then
run `staging-checks → log-review` for the window — the scan flags any
six-digit number on an authentication line. A provider outage is checked by
`staging-checks → sms-outage-drill` (the adapter pointed at an unreachable
host for one deploy; nothing can be sent).

Delivery can also be confirmed without the code: the provider's job id is
logged (`otp.sent providerRef`) and can be looked up in Netgsm's report
(`netgsmDeliveryReport`).

### 8.3 Real storage (`staging-checks → storage`)
server/test/storage.provider.test.ts (`npm run test:storage:provider`) and
e2e/storage-cors.mjs, in GitHub Actions as `velvet-staging-storage-test`
(GitHub OIDC; test-shaped keys only). Locally, without that role, the test
reports BLOCKED and the emulator is never used for it. Storage is not
verified until it passes against the staging buckets.

### 8.4 The full journey (on a phone; docs/DEVICE_QA_REPORT.md)

The SIM must be listed in `SMS_QA_REAL_NUMBERS` (DEC-083): its codes arrive
by real SMS and its account is a QA account the fixture may move.
1. Staging app: phone, then the real SMS code.
2. Stage 1; the application is received.
3. CI `staging-checks → review-fixture`: START_REVIEW, then REQUEST_EXTENDED.
4. Stage 2 with real photos from the phone (real S3 uploads); final review.
5. CI: APPROVE; the app begins membership; CI: ACTIVATE (the normal
   payment-confirmed path).
6. Dating setup, profile confirmation, Home.

Each CI transition prints its request id. No direct database edits.

### 8.5 Database assertions (`dist/db-check.mjs`, inside Render)
Every suite phase writes the read-only assertions it needs
(`STAGING_DB_CHECKS_FILE`): rows of a pair (ACTIVE/ENDED/BLOCKED matches,
blocks, open conversations, messages, pending introductions), an account's
deletion state, or the schema facts. CI runs each as a Render one-off job on
the API service — runtime login, TLS, read-only — with
`server/scripts/render-ops.mjs db-checks`. The database keeps no external
access.

### 8.6 Drills (`staging-checks`, typed confirmation)
- `fault-drill`: suspend the database; readiness 503 without detail;
  liveness 200; typed safe errors; resume; readiness recovers.
- `restore-drill`: point-in-time recovery ≥ 10 minutes back into a NEW
  instance; this runner's address allowed on that instance only; `migrate
  --verify`; the copy ends at the target time; the instance is deleted.
- `sms-outage-drill`: see §8.2.

## 9. Log review

`node dist/log-scan.mjs <exported api.log> --canaries <file>` looks for:
- the OTP codes, tokens, full phone numbers, birth dates and message texts
  the tools actually used (their canary files);
- signed URLs;
- credentials in connection strings;
- unredacted secret-like fields;
- AWS keys and private keys.

Findings are printed masked. On Render, export the logs from the dashboard
or a log stream first. The rehearsal scans the API's whole log on every run.
Regression test: server/test/logscan.test.ts.

## 10. Secrets

| Where | Holds |
|---|---|
| Render (staging workspace) | **Generated by Render, seen by nobody:** `OTP_SECRET`, `MEDIA_SIGNING_SECRET`, `DATABASE_RUNTIME_PASSWORD`, `INTERNAL_KEY_RUNNER_SECRET`, `INTERNAL_KEY_OPS_SECRET` (group shared with the cron), `INTERNAL_KEY_REVIEWER_SECRET` (typed once into the owner's review tool). From the database: `MIGRATION_DATABASE_URL`. Entered by the owner: `NETGSM_PASSWORD` (and the non-secret `NETGSM_USERCODE`, `NETGSM_HEADER`, bucket names, `AWS_ROLE_ARN`, `SMS_QA_REAL_NUMBERS`) |
| AWS | nothing stored: two OIDC roles (Render API; GitHub storage test) |
| GitHub Environment `staging` | secrets: deploy hook, Render API key, `STAGING_KEY_SECRET` (the one value copied from Render), `STAGING_REAL_PHONE(_2)`; variables: ids and URLs only |
| EAS | `EXPO_PUBLIC_API_URL` for the staging profile (not a secret) |
| The owner's computer | `~/.velvet-review.json` (0600): the API address, the reviewer name, the reviewer key |

`scripts/secret-scan.mjs` runs in CI over the tracked tree, the working tree
and every commit. `.env*` files are ignored, except `*.example`. The staging
tools' state and canary files hold QA tokens and canary values: they are
created with mode 0600, git-ignored, and never uploaded as CI artifacts.

## 11. Readiness

`/health/ready` answers 200 when all three hold:
- the database answers;
- the schema is this build's (`ok`), or a newer release's migrations are
  already applied while this instance still serves (`ahead`; migrations are
  expand-first);
- storage is reachable.

Otherwise it answers 503 (`mismatch` for a pending or edited migration),
with check names only — no hosts and no errors.

**Storage counts for readiness.** Without storage, uploads and photo
delivery fail.

**What Render probes.** Render health-checks `/health/live`, because it
restarts instances that keep failing the probe, and a restart cannot fix an
outage. A new instance proves readiness before it listens:
- the database is reachable (retried for a minute);
- the role is least-privilege;
- the schema matches the build;
- storage is reachable (retried for 30 s).

CI then checks `/health/ready` on the live service. Liveness stays 200
during a database or storage outage, so there is no restart loop.
