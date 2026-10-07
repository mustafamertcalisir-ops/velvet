# Staging stack — completion report

Date: 2026-10-07. Scope: the brief "PUT THE CURRENT PRODUCT ON A REAL
STAGING STACK". No product feature was added apart from the account
deletion UI the brief asked for. No Places, Travel, Directory, Events,
advanced messaging, reviewer dashboard, recommendation ML, billing
integration or admission feature was started.

> **Real staging is NOT deployed.** No Render workspace, managed database,
> S3 bucket, Netgsm account, domain, GitHub repository, EAS account or
> device was available to this phase. Nothing was provisioned, and the
> AWS/GCP/GitHub credentials present in the build sandbox belong to the
> sandbox, not to the project; they were not used.
>
> Everything marked **LOCAL REHEARSAL** ran on this machine against a
> staging-shaped stack (TLS PostgreSQL 16 with a non-superuser owner, an S3
> emulator, the production build of the API). Everything marked **REAL
> STAGING** is either BLOCKED or ready to run once the owner creates the
> accounts in §BLOCKED ITEMS. Nothing BLOCKED was mocked and called done.

## RESUMPTION — 2026-10-07 (provider accounts being created)

**Still no real staging result.** Nothing below has run against Render,
Render Postgres, S3, Netgsm, GitHub Actions, EAS or a phone yet; every
BLOCKED item stays BLOCKED until its run passes and is recorded here. What
changed is that each blocked check is now runnable **without any secret
passing through chat or through a person's hands**, and the local rehearsal
covers the new pieces.

| Area | Prepared (DEC-081 – DEC-084) | Local evidence |
|---|---|---|
| Database credentials | Render generates the API's database password; the release step creates the login and stores only a SCRAM verifier; the API derives its connection; the staging plan comes from the release step | rehearsal: login created then re-asserted, API signs in with SCRAM over TLS, the server's statement log never shows the password |
| Internal keys | key list as plain config, each secret its own generated variable; one copy (runner key → GitHub) | config tests |
| Database rows | `dist/db-check.mjs` (schema facts, pair rows, account deletion state, counts) as Render one-off jobs from CI | rehearsal: 12 assertions across the phases |
| Real S3 + CORS | one CloudFormation template (cfn-lint clean) with a GitHub-OIDC test role limited to test-shaped keys; real-browser CORS check | template tests; the CORS check itself needs real S3 |
| LIKE/BLOCK | both orders forced, then simultaneous rounds; disclosure check against an unknown member | rehearsal: both forced orders pass; 6 simultaneous rounds observed like-first 1×, block-first 5× |
| A real defect found | a block left the pair's waiting introductions PENDING until the next read (hidden and refused, but present in the rows) → now withdrawn in the block's transaction (DEC-084) | failing test first, then fixed |
| Deletion | a suite phase against a live match and conversation; retention dry run as a Render job | rehearsal: 10/10 + the account assertion |
| Internal auth | deployed refusals: unsigned, member token, stale, other environment, replay, changed body, missing scope | rehearsal: 7/7 |
| Real SMS | operator check on a laptop (codes never printed or stored), second-SIM enumeration, attempts lock, hourly cap, expiry; SMS outage drill; log scan flags six-digit numbers on auth lines | log-scan tests |
| Real journey | project SIMs as QA accounts (`SMS_QA_REAL_NUMBERS`), reviewer side from CI (`review-fixture`, prints request ids) | staging tests |
| Health / backup | database suspend/resume drill; point-in-time restore drill into a new instance | needs Render |
| QA community | 16 seeded numbers: compatible pair, incompatible gender, incompatible age, blocked pair, matched pair, non-Dating member — verified through the member API | rehearsal: seed twice, all checks |

Local checks after these changes: rehearsal **48/48** (smoke 23/23; suites
48/48 before and 7/7 after the restart; race 15/15; deletion 10/10; QA seed
twice; log review over 1855 lines with 119 canaries, 0 findings); server tests
154 passed, 10 skipped (the real-provider storage test, BLOCKED); app 297
passed; web E2E 621/621; typecheck and lint clean; workflows pass
`actionlint`; the generated CloudFormation template passes `cfn-lint`; secret
scan clean.

**Later the same day (owner's request: a link for friends, DEC-085/086):**
- **SMS:** no company yet, so staging uses **İleti Merkezi** (individual
  account) through a new adapter built from the official docs and SDK; Netgsm
  stays for later. Adapter tests: 7/7 (every documented status code, timeout,
  network, the safe answer through the API).
- **Web link:** `velvet-web-staging` (Render static site, staging channel,
  release gate in its build, `noindex`, iPhone home-screen ready). Built
  locally exactly as Render would: the gate passes and the landing page
  renders at iPhone size with the "Staging" mark (looked at).
- **iPhone app:** EAS profile `testflight` (store distribution of the staging
  build) and a native build gate (`scripts/check-build-env.mjs`). Needs the
  owner's Apple Developer membership; TestFlight external testing revises
  DEC-078.
- **Not decided yet:** how Apple's beta reviewers sign in; the KVKK notice.
  (Who decides invited testers' applications: decided — see below.)
- Server tests now 168 passed, 10 skipped (the real S3 test, BLOCKED).

### Invited testers: the owner decides; invited membership (DEC-087, DEC-088)

The owner decides friends' applications themselves, from a terminal tool on
their own computer, and starts an **invited (complimentary) membership**
after approval — no payment is recorded and nothing renews.

| Piece | What | Evidence (all **PASS (local)**) |
|---|---|---|
| Read API (`review:read`) | queue (first name, age, city, status, open actions) and application view (the private application; never a phone number); every view logged in `application_access_log` (0012, append-only, audit retention) | `test/reviewDesk.test.ts` 12/12 (incl. retention under a hold) |
| Invited membership (`membership:complimentary`, staging only) | APPROVED / MEMBERSHIP_PAYMENT_REQUIRED → ACTIVE_MEMBER via the normal lifecycle, audited with the reviewer as actor; `activation = complimentary`, `granted_by`, no billing event, no renewal; refused for suspended accounts, other states, paid memberships; absent in production | same file; `security.test.ts` (absent in production, scope refused) |
| Member screen | Membership → "Invited membership … There is nothing to pay." | `src/app/member/__tests__/membership.test.tsx` 2/2 |
| The tool | `server/scripts/review.ts` → `dist/velvet-review.mjs` (one 31 kB file, plain Node, Turkish); setup checks the key before saving (0600); asks before every decision | `test/reviewTool.test.ts` 10/10 |
| Rehearsal | the bundled tool as its own process against the staging-shaped API: queue, view, photo links (each served the image), confirmed decision, invited membership, database confirmation, refusals | 9 new steps; rehearsal **57/57** |
| Key | `reviewer` in the Blueprint, secret generated by Render (`INTERNAL_KEY_REVIEWER_SECRET`); typed once into the tool on the owner's computer | `infra.test.ts` (the key list loads as staging config) |

Files: `server/migrations/0012_review_desk.sql`; `server/src/admission/reviewDesk.ts`
(new), `config.ts`, `services.ts`, `http/endpoints.ts`, `http/app.ts`,
`records.ts`, `member/service.ts`, `retention/processor.ts`;
`server/scripts/review.ts` (new), `build.mjs`, `rehearse-staging.mjs`;
`server/test/reviewDesk.test.ts`, `reviewTool.test.ts` (new), `security.test.ts`,
`infra.test.ts`; `src/domain/models.ts`, `src/services/api/memberTypes.ts`, both
mocks, `src/app/member/membership.tsx` (+ test), `src/copy/en.ts`;
`infra/render/render.yaml`; docs DECISIONS (DEC-087, DEC-088), STAGING (§6,
§7 13b, §7.1, §10), API_CONTRACT, SECURITY_MODEL (regenerated matrix),
DATA_MODEL, DATA_RETENTION.

**REAL STAGING: BLOCKED** with the rest of the deploy (STAGING.md §7, step
13b). After this change: server 191 passed / 10 skipped; app jest 299; E2E
621/621; typecheck and lint clean.

An independent review of the change (a separate agent that had not written
it) found no privacy leak or lifecycle bypass, and six small issues, all
fixed and tested: a repeated invite for an account being deleted answered
200 (now 404); interactive browsing rewrote the numbered list another
terminal relied on (now only `liste` writes it, and a list older than two
hours is refused); `uyelik` now shows the full name before acting; only
https (or loopback) links are ever opened; settings are written atomically
as 0600, with a warning on terminals that cannot hide input; the tool runs
through a symlink. It also found that access logs were purged even under a
retention hold — now both `media_access_log` (pre-existing) and
`application_access_log` are kept for an account under a hold, like
`audit_events`.

**Correction to the first version of this report:** the signature-age limits
are reads 15 min / uploads 10 min on the media bucket and reads 2 min /
uploads 10 min on the verification bucket (OBJECT STORAGE below was wrong).

The deployment order, with who does what, is docs/STAGING.md §7.

---

Status words used below:
- **PASS (local)**: ran here, against the local rehearsal or the test suites.
- **READY**: written and wired in. It has not run against a real provider.
- **BLOCKED**: needs an account, credential or device that does not exist yet.

---

## FILES CHANGED

**Infrastructure (new)**
- `docs/INFRASTRUCTURE_DECISION.md`: provider research from official docs (hosting, PostgreSQL, storage, SMS), the alternatives, costs and exit risk, and what the owner must create (§6).
- `infra/render/render.yaml`: the staging Blueprint.
  - An isolated, protected project/environment.
  - Docker web service in Frankfurt, with migrations as the pre-deploy step and a liveness health check.
  - A cron for retention.
  - PostgreSQL 16 with `ipAllowList: []`.
- `infra/aws/*`:
  - Render OIDC trust policy and the API role policy.
  - Per-bucket policies: TLS only, role only, a signature-age limit.
  - The `incoming/` lifecycle, CORS, access logging and a README giving the order of operations.
- `infra/postgres/create-runtime-login.sql`: creates the API's runtime login. The password is set with `\password`, so it never appears on a command line.
- `.github/workflows/staging.yml`: CI/CD, staging only.
- `scripts/secret-scan.mjs`: scans the working tree and the whole git history.
- `.gitignore`.

**Server**
- **Migrations:**
  - `0010_runtime_role.sql`: the `velvet_runtime` group, its grants and a row-level-security policy per table. Append-only logs and plans stay read-only to it.
  - `0011_qa_accounts.sql`: the `qa_account` column.
- **New modules:**
  - `src/db/role.ts`: the runtime-role check.
  - `src/media/reconcile.ts`: media reconciliation.
  - `src/admission/stagingFixture.ts`: the staging review fixture.
- **Changed:**
  - `src/db/pool.ts`: `DATABASE_TLS` off/require/verify, with no silent downgrade.
  - `src/db/migrate-cli.ts`: migrations use the migration credential.
  - `src/main.ts`: startup retries, the role check and keep-alive settings.
  - `src/config.ts`: scopes, the CIDR allow list, Netgsm template rules, separate credentials.
  - `src/http/app.ts` and `src/http/endpoints.ts`:
    - the network restriction;
    - `Connection: close` on 413;
    - strict internal bodies;
    - readiness `ahead`;
    - the reconcile, retention dry-run, review-fixture and client-address routes.
  - `src/auth/sms.ts`: Netgsm OTP over REST v2, plus delivery reports.
  - `src/auth/service.ts`: QA accounts, and the provider reference logged.
  - `src/lib/log.ts`: provider references are kept intact.
  - `src/media/objectStore.ts`: listing.
  - `src/retention/processor.ts`: dry run and configured windows.
  - `src/member/service.ts`: the QA introduction pool is kept separate.
  - `src/services.ts`.
- **Tools (new or rewritten):**
  - `scripts/lib/staging.ts`: the shared client, with a signed staging-only preflight.
  - `scripts/smoke.ts`.
  - `scripts/staging-suite.ts`.
  - `scripts/qa-seed.ts`.
  - `scripts/staging-otp-check.ts`.
  - `scripts/log-scan.ts`.
  - `scripts/ops.ts`.
  - `scripts/deploy-staging.mjs`.
  - `scripts/rehearse-staging.mjs`.
  - `scripts/build.mjs`.
- **Tests:**
  - New: `roles`, `reconcile`, `staging`, `logscan`, `storage.provider` (BLOCKED without credentials).
  - Updated:
    - The harness runs as the runtime role; privileged fixtures use `t.admin`.
    - `sms`, `security`, `admission`, `account`, `privacy`, `queryplan`, `globalSetup`.
- `server/.env.example`, `server/README.md`.

**App**
- `src/app/member/delete-account.tsx` (new): the explanation step, then the confirmation.
- `src/app/member/privacy.tsx`: the "Your account → Delete account" row.
- `src/app/member/_layout.tsx`.
- `src/app/index.tsx`: a one-time signed-out notice.
- `src/components/StagingMark.tsx` (new).
- `src/components/Notice.tsx`: the `announce` option.
- `src/state/admission/store.ts`:
  - `deleteAccount`;
  - sign-out revokes the session on the server (best effort);
  - an epoch guard so a response that started before sign-out cannot write after it.
- `src/services/api/types.ts`, `src/services/http/httpAdmissionApi.ts`, `src/services/mock/{mockAdmissionApi,mockMemberApi}.ts`.
- `src/config.ts`: the release channel.
- `src/copy/en.ts`.
- `src/app/member/(tabs)/you.tsx`.
- `app.config.ts` (new): the staging variant.
- `eas.json`: the staging profile.
- `scripts/check-release-bundle.mjs`: `--channel`.
- **Tests:**
  - `src/state/__tests__/accountDeletion.test.ts` (new, 6 tests).
  - httpAdapters account tests.
  - The release-channel config test.
  - `e2e/member.mjs`: the delete-account journey, and server-side revocation on sign-out.
- `e2e/pg.mjs`: a realistic PostgreSQL mode (TLS, SCRAM, non-superuser owner).

**Docs**
- **New:**
  - `INFRASTRUCTURE_DECISION.md`.
  - `DEVICE_QA_REPORT.md` and `SCREEN_READER_QA_REPORT.md` (both BLOCKED; they hold the protocol).
  - This report.
- **Rewritten:** `STAGING.md`, `BACKUP_AND_RECOVERY.md`, `SMS_PROVIDER.md`.
- **Updated:**
  - `DECISIONS.md`: DEC-073 to DEC-080 and the pending list.
  - `MEDIA_ARCHITECTURE.md`: §7 reconciliation and §8 storage tests.
  - `DATA_RETENTION.md`: the dry run.
  - `SECURITY_MODEL.md`: regenerated, plus §5 network restriction.
  - `API_CONTRACT.md`, `BACKEND_ARCHITECTURE.md`, `PRIVACY_BOUNDARIES.md`, `SCREEN_MAP.md` (M-12).

## INFRASTRUCTURE PROVIDERS

Decided in DEC-073, with the research and its sources in docs/INFRASTRUCTURE_DECISION.md. Every capability claim is taken from the provider's own documentation, dated 2026-10-07. Anything the documentation does not state is marked NOT CONFIRMED there.

| Layer | Selected | Why, in one line | Main limitation |
|---|---|---|---|
| API hosting | **Render** web service (Docker), Frankfurt, a separate staging workspace on Pro | pre-deploy migrations before traffic moves; private networking to the database; OIDC to AWS; isolated environments | outbound IPs are shared, so a Netgsm IP allow list on them is weak |
| PostgreSQL | **Render Postgres 16**, `0.5c-1g`, Frankfurt | internal-only (`ipAllowList: []`); 7-day PITR on Pro | the internal TLS certificate is self-signed (`DATABASE_TLS=require`, not `verify`); a restore always creates a new instance |
| Object storage | **AWS S3**, eu-central-1, with separate media, verification and log buckets | real SigV4 presigning with exact length and content type; per-bucket policies; lifecycle; OIDC role with no static key | needs an AWS account; S3 is not backed up (BACKUP_AND_RECOVERY.md §3) |
| SMS | **Netgsm OTP SMS**, REST v2 | Turkish operator routes; a dedicated OTP product; OTP sends are exempt from İYS | Turkish numbers only; ASCII only; needs a company subscription and an approved sender header; no delivery webhook |

Vendor code lives only in adapters:
- `src/auth/sms.ts`;
- `src/media/objectStore.ts`;
- `src/db/pool.ts`;
- and the infra files.

Domain code knows `SmsProvider`, `ObjectStore` and a `pg` pool (INFRASTRUCTURE_DECISION.md §5).

## REAL STAGING URL

**None. BLOCKED.**
- There is no domain and no Render account.
- The intended URL is `https://api-staging.<domain>`. `render.yaml` carries the placeholder `api-staging.example.com`, to be replaced.
- The tools refuse any URL that is not https with "staging" in the host (loopback http is allowed for the rehearsal). They also require a signed, staging-only preflight to answer before they send anything.

## DATABASE DEPLOYMENT

**REAL STAGING: BLOCKED** (no Render account). `render.yaml` declares the following, and it is not reachable from the internet:
- `velvet-db-staging`;
- PostgreSQL 16, `0.5c-1g`;
- `ipAllowList: []`.

**LOCAL REHEARSAL: PASS.** The local database matches the managed shape:
- TLS required, with a self-signed certificate;
- SCRAM passwords;
- plain TCP refused by `pg_hba`;
- a non-superuser owner with CREATEROLE.

Results:
- The API refuses to start:
  - with TLS off in staging;
  - with the migration credential as its own;
  - as the schema owner.
- Every API connection was observed in `pg_stat_ssl`/`pg_stat_activity` as the runtime login over TLS.

**Least privilege (DEC-074, PASS (local) and server tests).**
- Migrations run as the owner, using `MIGRATION_DATABASE_URL`. That variable is deleted from the API process's environment at start.
- The API runs as a login in the `velvet_runtime` group. At startup it refuses to run if that role:
  - is a superuser;
  - has BYPASSRLS;
  - owns the schema, or is a member of the owner;
  - has CREATE on the schema;
  - is a member of `pg_read/write_all_data`.
- `roles.test.ts` proves the runtime role cannot:
  - change the schema;
  - truncate;
  - update or delete the append-only logs;
  - edit plans or the migration ledger.

## MIGRATIONS

**LOCAL REHEARSAL: PASS.**
- 0001→0011 were applied to a clean TLS database by the non-superuser owner.
- Checksum verification passed, with nothing pending or unknown.
- Schema facts were checked:
  - the active-match index;
  - the audit, retention, session and media tables;
  - RLS on every table;
  - the protective triggers;
  - the session constraint.
- The API refuses to start before the release step has run.
- `migrations.test.ts` also proves that a concurrent run does not double-apply.

**REAL STAGING: READY / BLOCKED.**
- Render runs `node dist/migrate.mjs` as `preDeployCommand`, before traffic moves to the new version. A failed migration stops the deploy.
- No manual database patch was made anywhere. The new role setup is itself migration 0010.
- Rollback limitations are in STAGING.md §3.

## OBJECT STORAGE

**REAL STAGING: BLOCKED** (no AWS account). Ready in infra/aws/:
- **Buckets:** `media` and `verification` are separate buckets. A third bucket holds access logs.
- **Encryption:** SSE-S3 everywhere, with TLS-only bucket policies.
- **Access:** only the API role may read or write.
- **Signature age:** the policy refuses signatures older than the API ever issues: media reads 15 min, verification reads 2 min, uploads 10 min in both buckets.
- **Lifecycle:** `incoming/` objects expire after 1 day.
- **Credentials:** none are static. The API role is assumed through Render OIDC, with the subject scoped to the one service. A fallback IAM user is documented for the case where OIDC is not available.
- **CORS:** only `PUT` with `content-type`, from the staging web origin only. There is no wildcard; native apps need no CORS.

**LOCAL REHEARSAL: PASS, with a stated limit.** It ran against s3rver, an S3 emulator, which **does not validate signatures**. Flows, keys, bucket separation and listing are therefore proven; signature enforcement is not.

## SIGNED UPLOAD / DOWNLOAD

**REAL STAGING: BLOCKED.** "Storage complete" is **not** claimed.
- `server/test/storage.provider.test.ts` is written and runs against real buckets when `STORAGE_PROVIDER_TEST=1` and credentials are set.
- In every run here it reports itself as BLOCKED (10 skipped).
- It covers:
  - a signed upload to both buckets;
  - an **expired** upload signature refused;
  - an **altered** signature refused;
  - a **different MIME** type than the one signed refused;
  - **more or fewer bytes** than the signed length refused;
  - unsigned reads refused;
  - a signed read that works and then **expires**;
  - a read URL that cannot be bent to another bucket or key;
  - copy, list and delete;
  - CORS from the allowed origin versus another origin.

**PASS (local).** The staging suite and the server media tests show:
- **EXIF/GPS is stripped:** a photo uploaded with both comes back with neither.
- **Verification photos** go to the verification bucket.
- **No applicant or member response** carries a verification URL. Verification media is readable only through the logged reviewer route.
- **Upload authorization** enforces the media class: applicant media is not profile media.
- **Body limits:** the size limit is enforced, and the 413 response now closes the connection (DEC-080).

## MEDIA RECONCILIATION

**PASS (local)** (DEC-075, MEDIA_ARCHITECTURE.md §7). How it runs:
- `POST /internal/media/reconcile`, scope `media:reconcile`, or `node dist/ops.mjs reconcile [--repair]`.
- **Dry run by default.**
- One run at a time, held by an advisory lock.
- Holds are re-read on every page.

Categories and what repair may do:

| Category | Repair action |
|---|---|
| `ORPHANED_INCOMING` | may delete |
| `FAILED_DELETION` | may delete |
| `UNREFERENCED` (after a 24 h grace) | may delete |
| `UNREFERENCED_VERIFICATION` | **never deleted**: marked NEEDS_REVIEW |
| `MISSING_OBJECT` | report only |
| `UNKNOWN_KEY` | report only |

Objects under a safety or legal hold are kept. An upload still in progress is never touched.

Evidence:
- `reconcile.test.ts`: every category; a repair that is idempotent; the lock; strict input.
- Rehearsal: a dry run over both buckets after the retention run found **0 missing and 0 failed-deletion objects** across 30 media objects.

**REAL STAGING: BLOCKED.** It needs S3; listing is billed as LIST requests.

## SMS PROVIDER

**Netgsm OTP REST v2** (`POST /sms/rest/v2/otp`), verified against Netgsm's official reference (docs/SMS_PROVIDER.md).
- **Request:** Basic auth with an **API sub-user**, one per environment.
- **Success:** only `code "00"` together with a job id counts as success.
- **Errors:** every documented error code maps to a safe class:
  - "we couldn't send a code" (`CODE_NOT_SENT`);
  - or "check your number" (`INVALID_PHONE`).
- **Configuration:** the template must be ASCII and at most 155 characters, and the configuration refuses one that is not.
- **Delivery:** the delivery-report adapter is for operators only.
- **Tests:** server tests against a fake Netgsm cover every code, non-JSON replies, timeouts and network failures.
- **Logs:** they never carry the code, the number or the message. The Netgsm job id is logged so a delivery can be traced.

**REAL STAGING: BLOCKED.** There is no Netgsm subscription, approved header or OTP package. Until there is, staging runs `SMS_PROVIDER=none`, so only designated test numbers can sign in. There is no fixed OTP anywhere outside the in-app mock.

## REAL OTP TEST

**BLOCKED** (no Netgsm account, no project-owned SIMs).
- `node dist/staging-otp-check.mjs [--with-expiry]` is ready. It is interactive: the operator types the code from the phone.
- It checks:
  - request;
  - delivery, timed;
  - wrong code;
  - correct code;
  - code reuse;
  - resend inside the cooldown refused;
  - resend after the cooldown, after which the old challenge is dead;
  - optionally, expiry (~11 min).
- It writes the typed codes to a 0600 canary file so the log review can prove they never reached the logs.

**PASS (local)** with test numbers. The smoke and suite runs show:
- a code issued;
- a wrong code refused;
- the test outbox readable once, with the staging key only;
- the resend cooldown;
- per-number and per-address rate limits;
- the outage copy for an unrouted number;
- **enumeration equivalence**: existing and new numbers get the same status and fields, and a wrong code is answered the same way. The timing gap was 21 ms against a 300 ms threshold.

## SESSION TEST

**PASS (local)**, with the staging suite running against the production build:
- Rotation issues a new token, the new token works, and the old one is refused.
- After sign-out the token is refused.
- "Sign out everywhere" refuses every session.
- A deletion request refuses the session immediately.
- **Sessions survive an API restart**, because they are stored in PostgreSQL.

The app now revokes the session on the server when signing out (best effort, 3 s). The E2E run checks that the token is refused afterwards.

**REAL STAGING: BLOCKED**, until a deploy exists. The CI job runs the same suite with a real redeploy in the middle.

## INTERNAL AUTH

**PASS (local)** (DEC-070, DEC-079; SECURITY_MODEL.md §5).
- **Signing:** every `/internal/*` request is signed (HMAC, staging-bound, scoped keys) and replay-protected. Signing is not weakened in staging.
- **Test scopes:** `test:otp` and `test:review` are refused in production, and their routes are not even registered there.
- **Network restriction:** `INTERNAL_ALLOWED_CIDRS` can also restrict `/internal/*` by caller address, never instead of the signature. This is tested.
- **Proxy hops:** the address the API sees is the real client's, not the platform proxy's and not a forwarded-for value the client chose. A suite check proves this through `/internal/test/client-address`.

Limitation: on Render the CI runner's address is not fixed, so the CIDR list mainly helps for operator tools run from fixed networks (INFRASTRUCTURE_DECISION.md §1.1).

**REAL STAGING: BLOCKED.** Render's `X-Forwarded-For` behaviour is NOT CONFIRMED until the deployed suite runs the proxy check.

## FULL STAGING USER JOURNEY

**PASS (local)** through the public API and the review fixture only, with **no direct database edits**. The path was:
1. Phone and OTP.
2. Stage 1.
3. `START_REVIEW`.
4. `REQUEST_EXTENDED`.
5. Stage 2 with photos.
6. FINAL_REVIEW.
7. APPROVE.
8. Payment confirmed: `ACTIVATE` uses the normal payment-confirmed path.
9. ACTIVE_MEMBER.
10. Introductions, a match, messaging, a block.
11. Deletion.

About the review fixture (DEC-076):
- It acts only on QA accounts (accounts created from test numbers). For any other application it answers NOT_FOUND.
- It uses the normal transitions, and every action is audited as `staging-fixture.<keyId>`.
- QA members are introduced only to QA members.

**QA seed:**
- `node dist/qa-seed.mjs seed` built 10 fixed QA accounts, one per state, from APPLICATION_RECEIVED to ACTIVE_MEMBER. The names use Turkish glyphs.
- It was run twice to prove it is repeatable.
- It refuses anything but `STAGING_ENVIRONMENT=staging`.

**REAL STAGING: BLOCKED**:
- on a deploy;
- on devices with the staging build;
- on real SMS for the human-tester path (DEVICE_QA_REPORT.md).

## MATCHING TEST

**PASS (local)**:
- A sees B; A likes B and there is no match yet; B likes A and there is **exactly one** match.
- Both members open the same conversation.
- Retrying both likes still leaves one match and one conversation entry.
- The server tests add:
  - simultaneous mutual likes;
  - many concurrent inserts for one pair, leaving exactly one ACTIVE match.

**REAL STAGING: BLOCKED.**

## BLOCK RACE TEST

**PASS (local)**, 3 rounds. In each round:
1. B has already liked A.
2. A's like (which would create the match) and B's block are sent **at the same moment**.
3. The check asserts that the block succeeds and that neither member has an active conversation or a usable match, whichever request lands first.

Limitation: all 3 local rounds resolved block-first, so the like-first interleaving was not observed locally. The check accepts either order, and blocking takes the same pair lock as matching. Network latency on real staging is likely to produce both orders.

**REAL STAGING: BLOCKED.**

## MESSAGING TEST

**PASS (local)**:
- A matched member can send.
- A retried send (same client id) does not duplicate.
- A member outside the match cannot send.
- An applicant cannot read or write the conversation.
- After a block, the conversation refuses messages **from both sides**, checked again after the restart.
- Messages persist across the restart.
- The per-minute message rate limit works.

**REAL STAGING: BLOCKED.**

## HEALTH / READINESS

**PASS (local).**
- `/health/live` answers `ok`. Render's health check uses this route, so a database outage does not cause a restart loop.
- `/health/ready` checks the database, the migrations and storage:
  - it answers 503 when any of them fails, with no infrastructure detail in the body;
  - `ahead` (the database knows newer migrations, during a rolling deploy) still counts as ready;
  - `mismatch` does not count as ready.
- At startup the API retries the database 12×5 s and storage 6×5 s.
- Faults rehearsed:
  - **Database stopped:** ready answers 503; requests get a typed, safe error; liveness stays up; the API recovers **without a restart**.
  - **Storage stopped:** ready answers 503, then recovers.

**REAL STAGING: BLOCKED.**

## LOGGING REVIEW

**PASS (local).**
- `node dist/log-scan.mjs` read the whole API log of the rehearsal: **1103 JSON lines**.
- It looked for **80 canary values**: every OTP, token, full phone number, birth date, message text, signed URL and credential that the run produced.
- It also checked for generic secret shapes.
- **0 findings.** Every match it would report is masked in its own output.
- Every log line is structured JSON and carries a request id.
- Regression tests:
  - `logscan.test.ts`, including "the API logger's own output passes";
  - `security.test.ts`, for provider-reference redaction.

**Request ids:** a well-formed client id is echoed end to end, in the header and in the error body. A malformed id is replaced.

**REAL STAGING: BLOCKED.** It will run on Render's log stream (14 days on Pro) with the canaries from the deployed suites and from the real-OTP check.

## RATE LIMITING

**PASS (local).**
- Limits tested:
  - messages per minute;
  - reaction replay (idempotent, then limited);
  - media upload authorizations;
  - the OTP resend cooldown;
  - reports per day.
- **The media and report limits survive an API restart**, because they are stored in PostgreSQL, not in memory.
- Per-address limits see the real client address (see INTERNAL AUTH).

**REAL STAGING: BLOCKED.**

## BACKUP / RESTORE TEST

**PASS (local), logical only.**
- `pg_dump -n app -n app_meta` was restored into an **isolated** database, never over the active one.
- The schema verified and the row counts matched.

**REAL STAGING: BLOCKED.**
- The Render PITR restore into a **new** instance is written as a procedure in BACKUP_AND_RECOVERY.md §4.1:
  - restore to a time;
  - verify migrations and checksums;
  - compare counts;
  - run the read-only smoke;
  - delete the instance.
- It needs the Render account.
- S3 objects are not backed up, deliberately for now (§3). Versioning is a recorded open item.

## RETENTION JOB

**PASS (local)** (DATA_RETENTION.md, DEC-067).
- **How it runs:** `POST /internal/retention/run { dryRun }` or `node dist/ops.mjs retention [--dry-run]`. On Render it is scheduled as the `velvet-ops-staging` cron, hourly at :17.
- **Dry run:** it reports the configured windows and what a run would do, and changes nothing. Its counts are an upper bound.
- **Rehearsal:**
  - the dry run counted the 15 QA accounts awaiting deletion without touching them;
  - the real run anonymized them and deleted their objects;
  - a repeat run was a no-op.
- **No periods were invented.** Every purge window is unset (`null`), so nothing is purged until the owner sets real periods. Only account anonymization after a deletion request runs, with a grace of 0 h in staging.
- Safety and legal holds keep their records.

**REAL STAGING: BLOCKED.**

## ACCOUNT DELETION UI

**PASS (local, web E2E; native not yet seen)** (DEC-077, SCREEN_MAP M-12).

**Where it lives:** Privacy → "Your account" → **Delete account**.

**Step 1 explains:**
- the profile leaves the community at once, and matches and conversations end;
- any membership ends;
- personal details and photos are then deleted;
- it can't be undone, and returning means applying again;
- "Some records may be retained where needed for safety, security or legal obligations."

The copy makes no legal claims beyond that policy, and it does not promise that every record disappears at once.

**Step 2 confirms:** "Delete your account?", with "Yes, delete my account" and "Keep my account". The swipe-back gesture is disabled on this screen.

**After deletion:**
- the device is cleared;
- a one-time notice says "Your account has been deleted and you've been signed out.";
- the server refuses the session immediately.

**Errors** keep the account unchanged and say so.

**Store protection:** an epoch guard stops a response that was in flight from writing to the store after the device has been cleared.

**Tests:**
- 6 store tests (`accountDeletion.test.ts`), including the stale-response test;
- adapter tests;
- the E2E journey, with screenshots `standard-80/81/82-*` viewed.

## IPHONE QA

**BLOCKED.** There is no iPhone, no staging build, no EAS or Apple Developer account and no deployed API. The protocol and the results table are in docs/DEVICE_QA_REPORT.md.

The staging build itself is ready (DEC-078):
- `APP_VARIANT=staging` gives "Velvet Staging", bundle id `app.velvet.membership.staging` and scheme `velvet-staging`, verified with `expo config`;
- a quiet "Staging" mark appears on the launch screen and in You;
- the EAS profile `staging` uses internal distribution only.

## ANDROID QA

**BLOCKED**, for the same reasons. The package is `app.velvet.membership.staging` and the protocol is the same.

## VOICEOVER / TALKBACK QA

**BLOCKED.** There is no device. Web rendering was **not** substituted, as the brief requires (docs/SCREEN_READER_QA_REPORT.md).

What exists is code-level semantics only. On the new screen:
- the headings are headers;
- focus moves to the confirmation heading on native;
- errors are announced;
- the info notice is announced;
- targets are at least 44 pt.

## DYNAMIC TYPE QA

**BLOCKED** (no device). The OS text-size protocol, up to the largest accessibility sizes, is in SCREEN_READER_QA_REPORT.md.

## CI/CD

`.github/workflows/staging.yml`, **staging only** (DEC-079).

**`verify` runs on every push and pull request:**
- the secret scan over the tree and history;
- app typecheck, lint and tests;
- server typecheck and tests on real PostgreSQL 16;
- the build;
- the full staging-shaped rehearsal;
- the staging-channel bundle gate.

**`deploy-staging` runs on `main` only, in the GitHub Environment `staging`:**
- the Render deploy hook for this commit, with migrations as the pre-deploy step;
- it waits until the deploy is live and readiness answers ok 3 times;
- the real smoke run;
- the suites before the restart;
- a **real redeploy**;
- the suites after the restart;
- cleanup if anything failed.

**What is not in the workflow:**
- there is no production job, production secret or store publishing;
- the state and canary files live in `runner.temp` and are never uploaded.

**Secret scan (PASS):** 9 committed files, 323 working-tree files and 1 commit of history — no secrets found. The scanner was checked against a planted secret in deleted history.

**Status: BLOCKED.** No GitHub repository or Environment exists, so the workflow has never run on GitHub. Every command in it was run locally.

## REAL STAGING SMOKE RESULT

**BLOCKED. There is no real staging smoke result**, because nothing is deployed.

The same binary, `node dist/smoke.mjs`, ran **23/23** against the local rehearsal. The rehearsal as a whole was **37/37**:
- staging suites 43/43 before the restart and 7/7 after;
- QA seed 10/10, twice;
- log review with 0 findings.

**Other local checks (2026-10-07):**
- **Server:** 140 passed and 10 skipped (the storage provider test, BLOCKED).
- **App:** 297 jest tests; typecheck and lint clean.
- **Bundles:**
  - the web QA and production bundles build;
  - the release gate passes;
  - the staging-channel gate passes with a staging API host and refuses a production one.
- **Web E2E (Playwright):** **621/621**:
  - small 202, standard 203, large 157, xl-abroad 39;
  - the production build against the real API, 20.

  This includes the delete-account journey and the server-side revocation on sign-out. The screenshots are in `docs/screenshots/account-deletion-standard.jpg`, viewed.

## BLOCKED ITEMS

Each item below waits on something only the project owner can create (INFRASTRUCTURE_DECISION.md §6). The order to follow is in STAGING.md §7.

| Blocked | Needs from the owner |
|---|---|
| Staging URL, TLS, deploy, migrations on Render, real smoke and suites, session/matching/race/messaging/rate limits on staging, log review on Render, health on Render, proxy-hop confirmation | a **domain** + DNS; a **Render account** with a staging workspace on **Pro** |
| Managed PostgreSQL; PITR restore test into a new instance | the Render account (above) |
| S3 buckets, IAM/OIDC, CORS; **real signed upload/download test**; reconciliation on S3 | an **AWS account for staging**, with billing alerts |
| Real SMS; **real OTP test** | a **Netgsm** company subscription, an approved sender header, an OTP package and a staging API sub-user; **≥ 2 project-owned Turkish SIMs** |
| CI/CD on GitHub | a **GitHub repository** with Actions and an Environment `staging` holding the secrets and variables named in the workflow |
| Staging app builds | an **Expo/EAS account**; Apple Developer and Google Play accounts for internal testing |
| iPhone, Android, VoiceOver, TalkBack and Dynamic Type QA | **one iPhone and one Android phone** with the staging build |

No secret should be pasted into this conversation. Each value goes into the provider's secret store or into the GitHub Environment.

## KNOWN LIMITATIONS

- **The emulator:** the local S3 emulator does not validate signatures, so signature, CORS and IAM enforcement is proven only by the BLOCKED provider test.
- **The database certificate:** Render's internal database TLS uses a self-signed certificate, so staging uses `require` (encrypted, server not authenticated) rather than `verify`. The traffic stays on Render's private network.
- **Render's outbound IPs** are shared:
  - a Netgsm IP allow list adds little without a paid dedicated IP;
  - `INTERNAL_ALLOWED_CIDRS` cannot pin the CI runner.
- **Test-number range:** `+90555000*` lies in an allocated Turkish mobile range, because Türkiye publishes no fictional range. Codes for these numbers never leave the server, and the tools refuse any API that fails the staging preflight.
- **One API instance only.** Rate limits and sessions are in PostgreSQL, so more instances should work, but this was not tested.
- **The block race** resolved block-first in all 3 local rounds (see above).
- **Retention dry-run counts** are an upper bound.
- **Purge windows** are all unset until the owner decides real periods.
- **S3 objects have no backup or versioning yet** (an open item in BACKUP_AND_RECOVERY.md).
- **Deletion and media:** a deletion request revokes sessions and removes the profile at once. Anonymization and photo deletion happen at the next hourly retention run, because `ACCOUNT_DELETION_GRACE_HOURS` is unset (0) in staging. The request itself does not delete the photos.
- **Undelivered SMS charges:** whether Netgsm charges for undelivered OTPs is NOT CONFIRMED.
- **The staging mark** depends on the build variant. A staging build pointed at a non-staging API is refused by the bundle gate, not at runtime.

## NEXT LOGICAL STEP

Nothing new is built until real staging exists. The owner creates, in this order:
1. the domain;
2. Render Pro;
3. the AWS staging account;
4. Netgsm and the SIMs;
5. the GitHub repository and its Environment;
6. EAS, with one iPhone and one Android phone.

Then, following STAGING.md §7:
1. Deploy.
2. Run the storage provider test.
3. Run the real OTP check.
4. Let CI run the smoke and the suites with the redeploy.
5. Do the PITR restore test.
6. Run the device and screen-reader protocols.
7. Replace every BLOCKED entry in this report with the real result.

Only after that should the next product phase be considered.
