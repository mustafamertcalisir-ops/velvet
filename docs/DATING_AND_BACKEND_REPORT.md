# Dating compatibility + production backend foundation — report

Date: 2026-10-05. Decisions: DEC-058 – DEC-065 (DEC-050 changed, DEC-052 superseded).
Not built, as instructed: Places, Travel, Directory, Events, professional
networking, recommendation ML, compatibility scores, boosts, paid pre-match
messages, reviewer dashboard, advanced chat, read receipts, voice, video.

## FILES CHANGED

**New — app**
- `src/domain/member/dating.ts` — identity / preference model and validation
- `src/domain/member/compatibility.ts` — THE eligibility function
- `src/domain/admission/submissions.ts` — server-side Stage 1/2 validation shared by mock and API
- `src/services/api/contract.ts` — `/v1` routes, error codes, HTTP statuses (shared)
- `src/services/http/{httpClient,httpAdmissionApi,httpMemberApi}.ts`
- `src/app/member/dating-setup.tsx`, `src/app/member/dating-preferences.tsx`
- Tests: `src/domain/__tests__/datingCompatibility.test.ts`, `src/services/__tests__/httpAdapters.test.ts`

**New — server (`server/`)**: `migrations/0001–0004`, `src/` (config, db pool/tx/migrations,
auth + SMS senders, admission + lifecycle + internal, member service + DTOs + provisioning,
media, rate limits, HTTP app, composition, entry), `test/` (harness, global setup,
auth, admission, member, privacy, contract, config, migrations), build script, README,
`.env.example`.

**New — E2E**: `e2e/pg.mjs`, `e2e/production.mjs`.

**Changed — app**: `introductions.ts`, `matching.ts`, `stage2.ts` (non-binary option),
`audit.ts` (MEMBERSHIP_EXPIRED), `copy/en.ts`, `services/api/{types,memberTypes}.ts`,
`services/index.ts` (backend selection), `services/mock/{mockMemberApi,mockAdmissionApi}.ts`,
`dev/communityFixture.ts`, `state/member/{memberStore,MemberProvider,useMemberQuery}`,
member routes (`_layout`, `index`, `confirm`, `home`, `you`, `profile/[id]`,
`conversation/[id]`), `verify/code.tsx` (dev hint via services), `components/ChoiceList.tsx`
(`aria-checked`), `config.ts`, tests `memberDomain`, `memberSlice`.

**Changed — tooling/docs**: `e2e/run.mjs`, `e2e/member.mjs`, `scripts/check-release-bundle.mjs`,
`package.json`, `tsconfig.json`, `eslint.config.js`, `README.md`, `docs/DECISIONS.md`,
`docs/DATA_MODEL.md`, `docs/SCREEN_MAP.md`; new `docs/DATING_COMPATIBILITY.md`,
`docs/BACKEND_ARCHITECTURE.md`, `docs/API_CONTRACT.md`, `docs/PRIVACY_BOUNDARIES.md`,
`docs/MEMBER_PRODUCT_VISION.md`; screenshots `dating-setup-widths.jpg`,
`dating-introductions-standard.jpg`, `production-bundle-real-api.jpg`.

## DATING IDENTITY MODEL

`DatingGenderId = 'WOMAN' | 'MAN' | 'NON_BINARY' | 'SELF_DESCRIBED'` + private
`selfDescription` (≤ 40) + `appearsAs` (categories: derived for fixed answers, chosen
when self-described). Asked after activation, Dating members only; never inferred;
free text never classified.

## DATING PREFERENCE MODEL

`DatingGenderPreference = 'WOMAN' | 'MAN' | 'NON_BINARY'`; `seeking` is a set
("Everyone" = all three); `ageRange` 18–80. Seeded from the extended application
(`seekingFromMeet`), confirmed in Dating setup, editable in Dating preferences.

## COMPATIBILITY RULES

One function, `datingEligibility`: active ×2 · not self · visible · no block · not
exhausted · both use Dating and completed setup · reciprocal categories · reciprocal age
ranges · safety hook. Used by the mock and the API for generation, re-checks and reactions.

## INTRODUCTION ELIGIBILITY

Batches (≤ 6/day, once per member per day, never refilled) only from eligible members;
exhaustion = liked ever, passed < 30 days, matched ever, introduced < 14 days. Waiting
introductions are re-checked on read and withdrawn when no longer eligible. Non-Dating
members: `NOT_USING_DATING`; Dating without setup: `DATING_SETUP_REQUIRED`.

## BACKEND TECHNOLOGY DECISION

Node 22 + TypeScript + Hono, PostgreSQL 16, `pg` with explicit SQL, plain SQL migrations,
sharp, Vitest on real PostgreSQL, esbuild bundle. Shared domain + contract imported from
the app. Host-agnostic (any managed Postgres; stateless API).

## DATABASE SCHEMA

Schema `app`, 28 tables: identity (accounts, otp_challenges, sessions, idempotency_keys,
rate_limit_events), admission (membership_applications, application_private_data,
application_referrals, application_dating_preferences, application_media,
information_requests, application_reviews, audit_events), membership (membership_plans,
memberships, billing_events), member (member_profiles, member_media, dating_settings),
introductions (introduction_batches, introduction_entries, reactions), matches & messages
(matches, conversations, conversation_participants, messages), safety (blocks, reports).
Constraints: unique pair key, unique reaction per introduction, unique batch per day,
idempotent messages, append-only audit, undeletable safety records, RLS on every table.

## AUTHENTICATION

Phone → random 6-digit OTP (CSPRNG, HMAC-stored, 10 min, 5 attempts, cooldown, hourly
limits) → account (once) → bearer session (SHA-256 stored, revocable). SMS senders:
console / outbox-file / capture for dev & tests (refused in staging/production); none →
fail closed. No fixed code on the server; the mock's code is absent from release bundles.

## API CONTRACT

`/v1` (docs/API_CONTRACT.md): auth, own application, membership begin/plans, member
me/confirm/profile/photos/dating/blocked, introductions today + reaction, members,
block, reports, matches, conversations, messages, signed media; `/internal` reviewer +
billing. Typed error codes; idempotency header.

## PUBLIC/PRIVATE DATA BOUNDARIES

Explicit DTOs only; `PublicMemberDTO` = 9 whitelisted keys, age derived in SQL; signed
expiring photo URLs. Never: surname, DOB, phone, Instagram, referral, Dating settings,
application answers, account id, coordinates, review data. Database closed to every role
but the API (PUBLIC revoked, RLS, explicit revokes for hosted client roles).

## LIKE/PASS TRANSACTION

Lock introduction row → lock pair (advisory) → read existing reaction, liked-back, prior
match, eligibility → `decideReaction` → insert reaction (unique per introduction) →
update entry → maybe insert match `ON CONFLICT (pair_key) DO NOTHING`. Same answer
replays; different answer `REACTION_ALREADY_RECORDED`; expired / withdrawn refused.

## MATCH CREATION

Exactly one per pair: serialised by the pair lock, guaranteed by `UNIQUE(pair_key)` and
`CHECK(member_a < member_b)`; ended matches are never re-created. Tested with 4 pairs
liking each other simultaneously and with a direct duplicate insert.

## MESSAGING AUTHORIZATION

Conversations only for active matches (created on first open, unique per match). Send
requires participant + active match + other member active + open conversation + no
block; text 1–2000; idempotent per client message id; 30/min, 1000/day.

## BLOCK/REPORT

Block: silent, idempotent, ends the match (`BLOCK`), closes the conversation, removes both
from each other's introductions/profiles/messages; uniform "unavailable" answers; records
kept (delete refused by triggers). Report: six structured reasons, optional conversation
(must belong to the pair), persisted `open`, 20/day; possible after blocking.

## MEDIA SECURITY

Content-checked, re-encoded (EXIF/GPS/all metadata dropped — verified on stored bytes),
private store with `application/`, `verification/`, `member/` keys, HMAC-signed URLs
(15/10/5 min), verification never minted for members, member photos are copies.

## MOCK/PRODUCTION SEPARATION

`services/index.ts` selects at build time: release → HTTP only (mock not bundled);
development → mock unless `EXPO_PUBLIC_BACKEND=http`. Release gate now also fails on the
mock server, `246810`, the mock storage key, the development plan, QA hosts, missing HTTP
adapters, and a non-https API URL (`--allow-local-api` only for local E2E builds).

## TESTS

- Jest **277/277** (20 suites): 181 admission tests unchanged; member slice 46
  (was 28); member domain 15; compatibility matrix 29 (new); HTTP adapters 6 (new).
- Server (Vitest, real PostgreSQL) **56/56** (7 files): auth 8, admission 14, member 19,
  privacy 6, contract 3 (the app's own stores against the API), config 4, migrations 2.
- E2E **596/596**: admission + outcomes unchanged (438); member slice 144 (Dating setup
  self-described at 375, Woman + edit at 393, non-Dating at 430); release bundle against
  the real API on PostgreSQL 14 (random OTP, mock code refused, Stage 1 submit, reviewer
  action, applicant refused member endpoints).
- Release gate passes on the production bundle; native iOS/Android bundles export.

## MIGRATIONS

`0001_foundation`, `0002_admission`, `0003_member`, `0004_access`; runner with checksums,
per-file transactions, advisory lock; `npm --prefix server run migrate` or at API start.

## KNOWN LIMITATIONS

- No SMS provider adapter (production sign-in fails closed), no object-storage adapter
  (local disk store), no billing provider (internal endpoint only), no reviewer tooling.
- Uploads are base64 JSON; direct signed uploads later.
- Batch generation evaluates the active Dating pool in the API (fine for thousands).
- Realtime is polling; designed for an outbox → push channel.
- Signed photo URLs expire in 15 minutes; long sessions re-fetch on next load.
- Web is the visual proxy; native keyboard, VoiceOver and Dynamic Type were not run on devices.
- `Button` on web does not expose `aria-disabled` (react-native-web overrides it); unchanged here.
- Friendship/community introductions do not exist (Dating-only by decision).

## NEXT LOGICAL STEP

Choose the providers behind the existing interfaces — SMS (sign-in), object storage
(media), billing (activation) — and deploy a staging API with a managed PostgreSQL;
then run the release bundle against staging. Do not begin Places, Travel or Directory.
