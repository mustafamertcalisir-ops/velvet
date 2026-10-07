# Production hardening + staging readiness — completion report

Date: 2026-10-06. Scope: the brief "PRODUCTION HARDENING + STAGING READINESS".
No new member feature was built (no Places, Travel, Directory, Events,
reviewer dashboard, advanced chat, ML, boosts, paid DMs, billing provider).

> **Staging is NOT deployed.** No hosting, managed database, buckets, SMS
> account or domain was provisioned. What ran is a *local staging-shaped
> rehearsal* of the production build (docs/STAGING.md §6).

---

## FILES CHANGED

**App (src/)** — `domain/member/matching.ts` (MatchStatus, end reasons, `likedSince`, `activeMatch`), `domain/member/introductions.ts` (match history, `rematchAfterDays`), `domain/admission/informationRequests.ts` (`verification_received`), `services/api/contract.ts` (upload DTOs, new routes, `CODE_NOT_SENT`, `requestId`; base64 routes removed), `services/api/types.ts`, `services/http/{httpClient,directUpload,httpAdmissionApi,httpMemberApi}.ts` (direct upload), `services/mock/{mockAdmissionApi,mockMemberApi}.ts`, `state/admission/store.ts` (media class), `lib/base64.ts`, `lib/testing/toBase64.ts`, `components/Button.tsx` (a11y), `app/application/request/[id].tsx` (identity photo receipt), `copy/en.ts`, `navigation/errors.ts`; tests: `components/__tests__/Button.test.tsx`, `lib/__tests__/base64.test.ts`, `services/__tests__/httpAdapters.test.ts`, `state/__tests__/reviewLifecycle.test.ts`, `domain/__tests__/{memberDomain,datingCompatibility}.test.ts`.

**Server** — migrations `0005_match_lifecycle`, `0006_account_lifecycle`, `0007_media_pipeline`, `0008_retention_and_integrity`, `0009_internal_auth`; new `src/account/service.ts`, `src/retention/processor.ts`, `src/media/{pipeline,objectStore}.ts`, `src/http/{endpoints,internalAuth,securityMatrix}.ts`, `src/lib/log.ts`, `src/compose.ts`; rewritten/changed `src/{main,config,services,ratelimit,records}.ts`, `src/auth/{service,sms}.ts`, `src/http/{app,errors}.ts`, `src/media/media.ts`, `src/member/{service,provision}.ts`, `src/admission/{service,internal,lifecycle}.ts`, `src/db/{migrate,migrate-cli}.ts`; `scripts/{build.mjs,smoke.ts,rehearse-staging.mjs,security-matrix.ts}`; `Dockerfile`, `.env.example`, `README.md`, `package.json` (AWS SDK; s3rver dev), `tsconfig.json`; tests: new `account`, `media`, `sms`, `security`, `queryplan` + `s3rver.d.ts`; updated `harness`, `admission`, `auth`, `config`, `contract`, `member`, `migrations`, `privacy`.

**E2E** — `e2e/member.mjs` (disabled-button semantics + keyboard; non-Dating copy), `e2e/production.mjs` (signed internal requests; browser direct upload against the real API).

**Docs** — created `DATA_RETENTION`, `STAGING`, `SMS_PROVIDER`, `MEDIA_ARCHITECTURE`, `BACKUP_AND_RECOVERY`, `SECURITY_MODEL`, this report; updated `DECISIONS`, `DATA_MODEL`, `ADMISSION_FLOW`, `MEMBER_PRODUCT_VISION`, `BACKEND_ARCHITECTURE`, `API_CONTRACT`, `PRIVACY_BOUNDARIES`, `DATING_COMPATIBILITY`, `SCREEN_MAP`. Root: `.dockerignore`.

## DECISIONS CORRECTED

- **DEC-060** revised: one match per pair *ever* → at most **one ACTIVE match per pair**, history kept.
- **DEC-050** clarified and **DEC-052** marked *partly* superseded: Today's Introductions is Dating-only in V1; Friendship/Community stay valid intents with a future discovery surface; the community vision is not superseded.
- **DEC-064** revised: "safety records can never be deleted" → explicit retention semantics (**DEC-067**).
- Also revised: DEC-051, DEC-058 (copy), DEC-059 (storage), DEC-061 (SMS boundary), DEC-062 (limits), DEC-063 (direct upload, classes), DEC-065 (signed internal auth).
- New: **DEC-066** account lifecycle + sessions, **DEC-067** retention, **DEC-068** environments/staging, **DEC-069** observability, **DEC-070** internal auth + policy registry, **DEC-071** billing boundary, **DEC-072** realtime deferred. Pending list updated.

## MATCH LIFECYCLE

`ACTIVE | ENDED | BLOCKED` with end reasons (BLOCK, UNMATCH, MEMBERSHIP_ENDED, ACCOUNT_DELETED). Partial unique index `matches_one_active_per_pair (pair_key) WHERE status='ACTIVE'` + consistency check; `ON CONFLICT … WHERE status='ACTIVE' DO NOTHING` under the pair lock. Likes count only after the pair's last ended match. Ended pairs are not reintroduced (`rematchAfterDays: null`); a rematch policy, if ever set, starts the pair fresh (tested). Active blocks make matches impossible; blocking now takes the pair lock. No unmatch UI. Tested: 4 simultaneous mutual-like pairs via the API; 12 raw concurrent inserts for one pair → exactly one row; history rows coexist.

## FRIENDSHIP / COMMUNITY STATUS

Valid stored intents; not part of Today's Introductions (Dating-only V1); never run through Dating compatibility. Home copy: "Dating introductions aren’t part of your experience right now." / "You joined for friendship and community. More community experiences will come later." No date. Future surface recorded in DEC-050/052 and MEMBER_PRODUCT_VISION.

## DATA RETENTION

docs/DATA_RETENTION.md classifies 18+ data families (purpose, visibility, active use, after deletion, safety/legal retention, anonymization, duration). Six deletion notions defined. Database: safety records and audit logs deletable only by the retention process (`SET LOCAL app.retention_purge='on'`); retention holds; all purge windows are configuration and **unset = never purged** (no legal period invented). Operational artifacts are always cleaned.

## ACCOUNT DELETION

`POST /v1/me/deletion {confirm:true}` → `deletion_requested`: sessions revoked, profile hidden, introductions withdrawn both ways, active matches ENDED + conversations closed, membership cancelled, sign-in refused, late payment confirmations refused, audited. Retention run → `anonymized`: private data, Dating data, referrals, sessions, OTPs, media objects (including any upload's incoming object) deleted; profile → hidden "Former member"; phone released; safety records and audit kept with opaque ids; holds defer it. Suspension/reinstatement via `safety:write`. Backend only — no deletion UI yet.

## SESSION SECURITY

SHA-256-hashed 256-bit tokens; absolute (60 d) and idle (30 d) expiry; sign out, sign out everywhere, rotation with reuse detection (family revoked) that keeps the absolute expiry; revocation reasons; suspended/deleting accounts refused on every request. Tested: expired, idle, revoked, rotated-reuse, suspension, deletion, two devices.

## OTP SECURITY

Random, HMAC-stored, 10 min, 5 attempts/code, 20 verifications/number/hour, 60/address, 5 sends/number/hour, 30/address, 30 s cooldown; failed sends consume the challenge. Tests: expired, reused (replay after success), concurrent duplicate verification → one session, too many attempts, too many sends, per-number verify limit, enumeration resistance (identical answers; invented challenge = expired), malformed input, SMS failure safe answer, no number/code in logs.

## STAGING ARCHITECTURE

Four environments via `APP_ENV`, environment-only fail-closed config, names-only `.env.example`, Dockerfile, release step `dist/migrate.mjs` + `--verify`, API refuses to start on schema mismatch, `/health/ready`. Staging: Node container, managed PostgreSQL, two private S3-compatible buckets, Netgsm or closed SMS + test numbers, signed scoped keys, no fixtures/fixed code/app billing. **Not deployed.**

## SMS INTEGRATION STATUS

`SmsProvider` boundary + country routing (fail closed). **Netgsm selected for staging, pending** an account and confirmation against its current official API reference; adapter implemented and tested against a fake vendor over HTTP (XML OTP endpoint, error-code classification, timeout). Alternative: Twilio (Türkiye sender-ID registration required; promotional traffic prohibited). Internal classes NOT_CONFIGURED / PROVIDER_UNAVAILABLE / RATE_LIMITED / DELIVERY_REJECTED / INVALID_PHONE → client `CODE_NOT_SENT` or `INVALID_PHONE`. docs/SMS_PROVIDER.md.

## MEDIA STORAGE

Direct upload (authorize → signed PUT → complete) to private object storage (S3 driver for staging/production; signed local driver for dev/test). Classes APPLICATION / VERIFICATION / PROFILE with distinct rules; verification in a separate bucket, never returned to any device, reviewer-only 2-min urls with an append-only access log. Content sniffing must match the declared type; sharp re-encode strips metadata; size-bounded reads; idempotent, lock-protected completion; abandoned uploads expire; settled uploads' incoming keys swept; deletion/purge rules per event. Base64 upload routes removed. Verified locally, against s3rver, and in the browser against the real API (prod-bundle E2E).

## DATABASE HARDENING

Status/consistency checks (matches, accounts, sessions, uploads), partial unique index for active matches, composite FKs (entries ↔ batches, reactions ↔ introductions, messages ↔ participants), new tables with RLS. EXPLAIN ANALYZE on 20,000 synthetic members: all per-member lookups are index scans (≤ 0.08 ms); the candidate pool is a deliberate scan — a SQL prefilter (mutual categories + age ranges) cut rows 13,326 → 990; no speculative indexes added (measurements showed none would help). Migrations tested from clean and on an existing 0001–0004 schema with data.

## API SECURITY

Policy registry declares auth/scope/membership/ownership/authorization/validation/DTO/errors/limits for every route; routes registered from it; docs table generated and drift-checked. Signed internal requests (env-bound HMAC, timestamp window, stored nonces, scopes); production network identity documented as a deployment concern.

## RATE LIMITING

PostgreSQL-backed for OTP sends, OTP attempts (per code, per number, per address), profile updates, upload authorizations, reactions, messages, reports, Dating settings, deletion requests; shared across instances (tested with two app instances); proxy-aware client address that clients cannot spoof.

## OBSERVABILITY

JSON logs with request ids (X-Request-Id on every response and error body), key-based redaction + phone masking, access log per request, server-side error class/db code/stack; clients see safe codes. `/health/live`, `/health/ready` (database, migrations, storage; pass/fail only).

## MIGRATIONS

Checksums preserved (0001–0004 untouched); 0005–0009 new and unreleased. Release workflow: build → migrate → verify → start → ready → smoke. Rollback limits documented (forward-only; restore for irreversible changes; expand→migrate→contract).

## BACKUP / RECOVERY

docs/BACKUP_AND_RECOVERY.md: what to back up (DB + PITR, both buckets with versioning), secrets excluded, DB↔storage consistency, retention re-run after restore, pre-migration snapshots, restore-test procedure; provider-specific guarantees and RTO/RPO left open.

## ACCESSIBILITY FIX

The shared Button now passes `disabled` to Pressable: react-native-web renders a native `<button disabled aria-disabled="true">` (previously aria-disabled was silently dropped); native keeps accessibilityState + ignored presses. Tests: RNTL (disabled/busy state, presses ignored, label/hint) and E2E (disabled = BUTTON + disabled + aria-disabled; not focusable, Enter inert; once enabled, keyboard focus reaches it and Enter activates).

## SECURITY TESTS

server/test/security.test.ts + account/auth/media/member/privacy: SQL injection (paths, bodies, phone), malformed/odd JSON, oversized bodies, unauthenticated access to every session endpoint, expired/idle/revoked/rotated sessions, applicant on every member endpoint, member session/unsigned/wrong scope on every internal endpoint, signature tampering (secret, key, stale, future, body, path, method, environment, malformed), nonce replay, horizontal access (introductions, matches, conversations, uploads, information requests), private DTO leakage, signed-url expiry and bucket/class bending, OTP enumeration, reaction replay, concurrent match creation, blocked-member messaging, deleted/suspended member access, safe 500s, request ids, log redaction, health, shared rate limits.

An independent review (a separate agent that had not seen the work) found 9 issues (no high severity); all were fixed and covered: rotation extending absolute expiry; payment confirmation for a deleting account; holds on anonymized accounts; raw incoming objects outliving uploads/deletion; legacy `deleted` accounts not anonymized by 0006; block/react and message/block races; concurrent completions exceeding the photo limit; environment-unbound signatures; nonce-pruning edge.

## STAGING SMOKE TEST

`server/scripts/smoke.ts` (23 checks: health, OTP boundary, auth, application submit with direct uploads, internal review transitions, membership guard, upload class authorization, activation via internal billing, Dating compatibility + introductions, DTO isolation, signed delivery, mutual match + replay, conversation authorization, block). Refuses to run without `SMOKE_ENVIRONMENT=staging`; cannot run in production. **Ran only in the local staging-shaped rehearsal: 8/8 rehearsal steps, 23/23 smoke checks.** Not run against a deployed staging (none exists).

## ALL TEST RESULTS

| Check | Result |
|---|---|
| App typecheck / lint | pass / pass |
| App unit (Jest) | 288/288 (22 suites) |
| Server typecheck | pass |
| Server (Vitest on real PostgreSQL 16: integration, security, concurrency, migrations clean + existing, query plans, S3 emulation) | 116/116 (12 files) |
| Server build (main, migrate, smoke) | pass |
| QA web build / production web build | pass / pass |
| Release gate (`check:release:local`) | pass |
| E2E full (4 mock runs + production bundle vs real API) | 611/611; production part re-run after final server fixes 20/20 |
| Native export (iOS + Android) | pass |
| Staging-shaped rehearsal + smoke | 8/8, 23/23 |
| `npm audit --omit=dev` (server) | 0 vulnerabilities (dev-only s3rver chain: 4) |

## KNOWN LIMITATIONS

- No staging deployment; no provider chosen for hosting, database or storage.
- Netgsm adapter untested against the real service; account, sender header and official API confirmation pending; no SMS sandbox confirmed.
- s3rver does not validate signatures — real S3 signature/length enforcement unverified here; Dockerfile not built (no Docker daemon available).
- Production network protection of `/internal/*` not implemented (deployment concern).
- Retention durations, deletion grace window, NOT_ADMITTED retention, billing record-keeping: undecided.
- No account-deletion UI; no unmatch; rematch policy off.
- Database ↔ storage reconciliation job and restore-time deletion replay not built.
- Realtime remains fetch-on-open.

## NEXT LOGICAL STEP

Provision staging for real: choose hosting + managed PostgreSQL + S3-compatible storage, open the Netgsm account (confirm the API and register the sender header), set secrets, deploy the image with the release step, run the smoke flow against it, and schedule the retention run. In parallel, get the retention durations decided so the windows can be configured. No new member features until that foundation runs in staging.
