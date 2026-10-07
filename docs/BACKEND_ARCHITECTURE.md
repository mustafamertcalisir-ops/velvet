# Backend architecture

The production backend (DEC-059 – DEC-072). One API service on PostgreSQL
owns every decision; the app talks to it through the same ports it already
used with the mock. Hardened for staging in this phase: match lifecycle,
account lifecycle and retention, session rotation, SMS provider boundary,
direct uploads to private object storage, signed internal requests, an
endpoint policy registry, structured logs and health checks. Companion
documents: SECURITY_MODEL.md, MEDIA_ARCHITECTURE.md, DATA_RETENTION.md,
STAGING.md, SMS_PROVIDER.md, BACKUP_AND_RECOVERY.md.

---

## 1. Technology decision

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript | Same language as the app; the shared domain (`src/domain/**`) and contract (`src/services/api/contract.ts`) are imported directly — one source of rules |
| HTTP | Hono (`@hono/node-server`) | Small, typed, standards-based (Fetch API); in-process `app.request()` makes the whole HTTP stack testable without sockets; portable to other runtimes |
| Database | PostgreSQL 16 | Relational integrity, unique constraints and transactions for match creation; row-level security for defence in depth; hostable anywhere (Neon, Supabase Postgres, RDS, Cloud SQL) |
| DB access | `pg` + explicit SQL | Every column a response can carry is visible in the query; no ORM spreading rows into objects |
| Migrations | Plain ordered `.sql` files + a small runner | Reviewable DDL; checksums refuse edited migrations; advisory lock against concurrent runners |
| Images | `sharp` | Content check + re-encode strips all metadata (EXIF/GPS) |
| Object storage | `@aws-sdk/client-s3` + presigner | Any S3-compatible private bucket; provider-presigned direct uploads and deliveries |
| Tests | Vitest against a real PostgreSQL | Ephemeral cluster per run (or `TEST_DATABASE_URL`); database per test file / per test |
| Build | esbuild → ESM bundles (`dist/main.mjs`, `dist/migrate.mjs`, `dist/smoke.mjs`) | Bundles the shared domain via the `@/` path; npm dependencies stay external; server/Dockerfile packages them |

Not chosen, deliberately: a backend-as-a-service SDK talking to the
database from the app (the app must never query tables — DEC-064), GraphQL
(the contract is small and explicit), an ORM.

## 2. Layout

```
server/
  migrations/              0001 foundation · 0002 admission · 0003 member · 0004 access
                           0005 match lifecycle · 0006 account lifecycle · 0007 media pipeline
                           0008 retention + integrity · 0009 internal auth
  scripts/                 build · smoke (staging) · rehearse-staging · security-matrix (docs)
  Dockerfile               the API image (release step + web process)
  src/
    main.ts                config → schema check (or migrate in dev/test) → serve
    compose.ts             SMS provider and object store from configuration
    config.ts              environment validation (fail-closed in staging/production)
    services.ts            composition root
    db/                    pool + tx (retry on 40001/40P01) + advisory locks · migration runner, status, CLI
    http/                  endpoint policy registry · Hono app · signed internal auth · typed errors · security matrix
    auth/                  OTP + sessions (rotation, revocation) · SMS provider boundary (Netgsm, routing, test numbers)
    account/               deletion requests · suspension · retention holds
    admission/             applicant service · lifecycle moves + audit · internal (reviewer, reviewer media, billing)
    member/                member service · DTOs · provisioning at activation
    media/                 object store (s3 | local) · direct-upload pipeline + delivery · image sanitiser
    retention/             the retention process (expiry sweep, anonymization, purge windows)
    lib/                   clock · crypto · structured logging with request ids
    ratelimit.ts           sliding windows in PostgreSQL
    records.ts             explicit row → own-record mappers
  test/                    real-PostgreSQL integration, security, concurrency, migration and query-plan tests
src/services/
  api/contract.ts          the wire contract (routes, error codes, upload DTOs) — shared
  http/                    the app's HTTP client (incl. direct upload) and AdmissionApi / MemberApi adapters
  mock/                    the mock server (development + deterministic E2E only)
  index.ts                 backend selection (build-time)
```

## 3. Request path

```
app screen → store (admission / member) → port (AdmissionApi | MemberApi)
           → HTTP adapter → /v1/... → Hono route → auth (bearer → account)
           → service (one transaction; membership guard; shared domain rules)
           → explicit DTO → JSON
```

- Routes are registered from the endpoint policy registry
  (`server/src/http/endpoints.ts`); a test pins every route in the shared
  contract (`ROUTES`) to a policy with the same method and path, and
  `server/test/contract.test.ts` runs the app's own stores and adapters
  against the real API. Authentication middleware comes from each policy's
  declared `auth`, never from the path (SECURITY_MODEL.md).
- Every member operation runs in one transaction that first checks
  `canAccessMemberProduct(application.status, membership.status)` — the same
  function the app's route guard uses.
- Errors are `AppError(code)` → `{ error: { code, message, fields?, retryAfterMs?, attemptsRemaining?, requestId } }`
  with the contract's HTTP status. Anything unexpected becomes `INTERNAL`;
  the server log records the error class, database code/constraint and
  stack with the request id — never bodies, tokens or personal data (DEC-069).

## 4. Authentication and accounts

Phone → OTP → account, behind `createAuthService` (DEC-061, DEC-066):

- `POST /v1/auth/otp` — validates E.164; per-address and per-number limits;
  30 s resend cooldown; consumes earlier challenges; stores
  `HMAC-SHA256(OTP_SECRET, challengeId:code)`; sends through the
  `SmsProvider`. A failed send is classified internally, logged without the
  number or code, the challenge consumed, and the client answered
  `CODE_NOT_SENT` (or `INVALID_PHONE`). Answers are identical for known and
  unknown numbers.
- `POST /v1/auth/otp/verify` — constant-time compare; 5 attempts per code
  (counted even when wrong — committed before answering) and 20 per number
  per hour; creates the account once (audited `PHONE_VERIFIED`); refuses
  suspended / deleted accounts after proof; issues a 32-byte bearer token
  stored as SHA-256 with a session family.
- Every request: hash lookup; refused if revoked, idle (30 days), past its
  absolute expiry (60 days) or the account is not active. A rotated token
  presented again revokes its family (reuse detection).
- `POST /v1/auth/sign-out`, `/auth/sign-out-all`, `/auth/session/rotate`.
- `POST /v1/me/deletion` — the deletion request (account/service.ts);
  anonymization by the retention process (retention/processor.ts).
- SMS providers: `netgsm` (+90, behind `routeSms`), `none` (fail closed);
  `console` / `outbox-file` / `capture` are development/test only and refused
  in staging/production. Staging test numbers → internal outbox. No fixed or
  development code exists on the server (tested).

## 5. Transactions and concurrency

| Operation | Protection |
|---|---|
| Stage 1 submit | advisory lock per account + `UNIQUE(account_id)` + idempotency key |
| Stage 2 / information update | row lock on the application + idempotency key table |
| Day's batch | advisory lock per member+day + `UNIQUE(member_id, batch_date)` |
| Reaction | `SELECT … FOR UPDATE` on the introduction, then advisory lock on the pair key, then read "liked back?"; `UNIQUE(introduction_id)` on reactions |
| Match | partial unique index `matches_one_active_per_pair ON (pair_key) WHERE status = 'ACTIVE'` + `INSERT … ON CONFLICT (pair_key) WHERE status = 'ACTIVE' DO NOTHING`; `CHECK(member_a < member_b)`; status/ended consistency check; history kept |
| Conversation | `UNIQUE(match_id)`; created on first open |
| Message | `UNIQUE(conversation_id, sender_id, client_message_id)` |
| Block | `UNIQUE(blocker_id, blocked_id)`; sets the ACTIVE match BLOCKED and closes its conversation in the same transaction |
| Message sender | composite FK `(conversation_id, sender_id)` → participants: only a participant can be a sender |
| Reaction / introduction | composite FKs: a reaction's members are its introduction's viewer and candidate; an entry belongs to its batch's member and day |
| Deletion request | row lock on the account; sessions, profile, matches, conversations, introductions and membership changed in one transaction |
| Upload completion | row lock on the upload (twice: before and after processing); a losing racer deletes its own copy |
| Internal request | `PRIMARY KEY(key_id, nonce)` — a nonce is accepted once |
| Billing event | `PRIMARY KEY(provider_event_id)` — processed once |
| Rate limit | advisory lock per bucket+subject |

`tx()` retries serialization failures and deadlocks (40001/40P01) up to 3
times. Simultaneous mutual likes are tested repeatedly (4 pairs at once):
exactly one ACTIVE match per pair, exactly one of the two responses reports
it. The partial unique index alone is also tested with 12 separate
connections inserting an ACTIVE match for one pair at the same time: exactly
one row survives.

### Measured query plans (introduction generation)

`server/test/queryplan.test.ts` seeds 20,000 members with history
(≈100k batches, ≈300k introductions, ≈150k reactions, ≈10k matches, ≈6.7k
blocks), runs `ANALYZE`, then `EXPLAIN (ANALYZE, BUFFERS)` on the real
queries. Last run (local PostgreSQL 16):

| Query | Plan | Time |
|---|---|---|
| prior reactions of the viewer | Index Scan `reactions_pair_idx` | 0.04 ms |
| match history of the viewer | BitmapOr `matches_a_idx` / `matches_b_idx` | 0.03 ms |
| recent introductions (14 days) | Index Scan `introduction_entries_viewer_idx` | 0.03 ms |
| blocks, both directions | Index Only Scan unique (blocker, blocked) + `blocks_blocked_idx` | 0.05 ms |
| today's batch | Index Scan unique (member, date) | 0.03 ms |
| liked back since the pair's last ended match | `reactions_to_idx` (partial, LIKE) + `matches_pair_history_idx` | 0.04 ms |
| active matches | BitmapOr partial `matches_active_a_idx` / `_b_idx` | 0.04 ms |
| participants by id (6 joins) | primary / unique index scans only | 0.08 ms |
| candidate pool, no prefilter | sequential scans + hash joins | 62 ms, 13,326 rows |
| candidate pool, SQL prefilter (mutual categories + age ranges) | sequential scans + index lookups | 52 ms, 990 rows |

Conclusions acted on: every per-member path is already an index scan (no
new index was needed); the pool is a deliberate full pass because most
members are candidates, so the improvement that matters is shipping fewer
rows — the mutual gender-category and age-range conditions now run in SQL
(`POOL_PREFILTER`, 13× fewer rows to the API), mirroring the shared
eligibility function, which still decides every candidate. Indexes for
active membership, visibility, setup completion, gender or age were
measured not to help at this selectivity and were not added. Revisit the
pool at around 10× the current synthetic size.

## 6. Media

Direct uploads to private S3-compatible object storage (local disk in
development), three media classes with different authorization, content
identification and re-encoding at completion, short-lived signed delivery,
a separate verification bucket with reviewer-only, logged access, and
retention-driven purges. Full description: MEDIA_ARCHITECTURE.md.

## 7. Rate limits

PostgreSQL sliding windows (`rate_limit_events`), shared by all instances
(tested with two app instances on one database); a Redis limiter can
replace it behind `RateLimiter`. Policy in DEC-062 and SECURITY_MODEL.md §7.

## 8. Migrations

Ordered SQL files, one transaction each, checksummed in
`app_meta.schema_migrations`; an edited applied migration is refused; a
session advisory lock serialises runners. `migrationStatus` reports pending,
changed and applied-but-unknown migrations; it backs `npm run migrate --
--verify`, the API's start-up check and `/health/ready`. Development and
test migrate at start; staging and production run `node dist/migrate.mjs`
as a release step and the API refuses to start on a mismatched schema
(STAGING.md §3, rollback limitations included). Tested: from a clean
database, on an existing 0001–0004 schema with data (status backfills,
session families, 'deleted' accounts anonymized, new constraints enforced
on carried-over rows), concurrent runners, edited files. `0004_access`
enables row-level security on every table (a test fails if a future table
lacks it — 0006/0007/0009 enable it on theirs). `0010_runtime_role` creates
the `velvet_runtime` group the API's login belongs to (grants + a
`runtime_access` policy per table; DEC-074): migrations run as the owner
(`MIGRATION_DATABASE_URL`), the API as the runtime login, and the whole test
suite runs as a runtime login too. `0011_qa_accounts` marks staging QA
accounts (DEC-076).

## 9. Environments and the mock

| | App backend | Server |
|---|---|---|
| Local development | mock (default) or `EXPO_PUBLIC_BACKEND=http` + `EXPO_PUBLIC_API_URL` | `APP_ENV=development`, console SMS, local storage, `DEV_SEED=1` (development plan), development internal key |
| Deterministic E2E (QA bundle) | mock + development hooks | — |
| E2E of the release bundle | HTTP to `http://127.0.0.1:8788` | `APP_ENV=test`, outbox SMS, local storage (signed upload/download routes), signed internal key |
| Staging | HTTP to an https staging API | `APP_ENV=staging` (STAGING.md) |
| Production | HTTP to an https API (release gate) | `APP_ENV=production`: strong secrets, https, explicit CORS, Netgsm or closed SMS, S3 storage, no test hooks |

Release bundles never contain the mock, its fixed development code,
fixtures or development hooks: the mock is loaded by a conditional
`require` whose condition is a build-time constant, and
`scripts/check-release-bundle.mjs` fails the build if any marker remains or
the API URL is not https.

## 10. Internal endpoints

`/internal/*`, signed requests with scoped keys (DEC-070,
SECURITY_MODEL.md §5) — never a member or applicant session:

- `POST /internal/reviewer/applications/{id}/actions` (`review:write`) — `{ reviewerId, action }`
- `POST /internal/reviewer/applications/{id}/media/{mediaId}/access` (`review:media`) — `{ reviewerId, purpose }` → 2/10-minute url, logged
- `POST /internal/billing/payment-confirmed` · `/membership-expired` (`billing:write`) — `{ accountId, providerEventId, provider }`
- `POST /internal/safety/accounts/{id}/suspend` · `/reinstate` · `/holds`, `POST /internal/safety/holds/{id}/release` (`safety:write`)
- `POST /internal/retention/run` (`retention:run`) → counts and configured windows; `{ dryRun: true }` changes nothing
- `POST /internal/media/reconcile` (`media:reconcile`) → storage ↔ database report; dry run unless `{ mode: 'repair' }` (MEDIA_ARCHITECTURE.md §7)
- `POST /internal/test/otp` (`test:otp`, absent in production) — reads a staging test number's code once
- `POST /internal/test/applications/{id}/review` (`test:review`, absent in production) — the staging review fixture, QA applications only (DEC-076)
- `POST /internal/test/applications/lookup` (`test:review`, absent in production) — the application of an active QA number (the real-SIM journey, DEC-083)
- `POST /internal/test/client-address` (`test:review`, absent in production) — the address the API resolved for the caller; the staging tools' preflight and the proxy-hop check

`INTERNAL_ALLOWED_CIDRS` can additionally restrict `/internal/*` by caller
address (never instead of the signature).

No reviewer dashboard exists; real tooling, a billing provider adapter and
a scheduler call these.

## 11. Realtime (designed for, not built)

Messages and matches are polled by the app today (on open and focus). The
API is structured for a push channel later without changing the contract:
every write that another member must see (`messages`, `matches`,
`blocks`) happens in one transaction, so a transactional outbox
(`AFTER INSERT` → `pg_notify` or an outbox table) can fan out to a
WebSocket/SSE gateway that re-authorises each subscriber with the same
membership and block checks. Blocks must cut a live channel immediately.

## 12. Operations notes

- Stateless API; scale horizontally behind TLS. All shared state (rate
  limits, nonces, sessions) is in PostgreSQL.
- Secrets: `OTP_SECRET`, `MEDIA_SIGNING_SECRET` (≥ 32 chars each), internal
  keys (`INTERNAL_KEYS_JSON`), database, storage and SMS credentials —
  in the secret manager only.
- Logs: JSON lines on stdout with request ids (DEC-069); `LOG_LEVEL`.
- Health: `/health/live`, `/health/ready` (database, migrations, storage).
- Backups and recovery: BACKUP_AND_RECOVERY.md.
- The API connects as the schema owner; no other role has access (DEC-064).
  For a hosted database with client roles (e.g. Supabase `anon`), 0004
  revokes them explicitly.

## 13. Known limitations

- Staging is designed and rehearsed locally, not deployed (no provider chosen).
- The Netgsm adapter is tested against a fake vendor only; the account and
  the official API reference are pending (SMS_PROVIDER.md).
- s3rver (tests, rehearsal) does not validate S3 signatures.
- Production network-level protection of `/internal/*` is a deployment task.
- Retention durations are undecided; nothing is purged by default except
  operational artifacts.
- No account-deletion UI yet (the endpoint exists).
- Curation is a stable daily order; no curation tooling.
- Moderation of photos is a status field; no moderation workflow.
- Realtime is fetch-on-open (DEC-072).
