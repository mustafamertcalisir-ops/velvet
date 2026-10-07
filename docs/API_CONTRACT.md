# API contract — v1

The wire contract between the app and the production API. Source of truth:
`src/services/api/contract.ts` (routes, error codes, HTTP statuses, upload
DTOs), shared by the app's HTTP adapters (`src/services/http/`) and the
server, which registers every route from its policy registry
(`server/src/http/endpoints.ts`; the full per-endpoint security policy is in
SECURITY_MODEL.md). Response shapes are the port types the app
already renders (`src/services/api/types.ts`, `memberTypes.ts`).

Pinned by: `src/services/__tests__/httpAdapters.test.ts` (fake fetch) and
`server/test/contract.test.ts` (the app's own stores and adapters against
the real API and PostgreSQL).

---

## Conventions

- Base: `https://<api>/v1`. JSON in, JSON out. UTF-8 (Turkish text as is).
- Auth: `Authorization: Bearer <session token>` — the token is the only
  identity; account ids are never sent by the client.
- Idempotency: submissions carry `Idempotency-Key: <client key>`; the same
  key (or any repeat after acceptance) returns the same resource.
- Timestamps: ISO 8601 UTC. Calendar dates: `YYYY-MM-DD` (introductions use
  the product calendar, Europe/Istanbul).
- Media: only signed, expiring URLs — the storage provider's presigned urls
  in staging/production; `/v1/storage/object?b=…&k=…&exp=…&sig=…` with the
  local development driver. Photos are uploaded directly to storage
  (§Media), never as base64 JSON.
- Body limits: 64 KiB JSON (413 above). Photos ≤ 8 MiB per object.
- Correlation: every response carries `X-Request-Id`; error bodies repeat
  it as `requestId`. A well-formed inbound `X-Request-Id` is kept.

## Errors

```json
{ "error": { "code": "REACTION_ALREADY_RECORDED", "message": "You already answered this introduction.",
             "fields": ["…"], "retryAfterMs": 30000, "attemptsRemaining": 2, "requestId": "req_…" } }
```

| Code | HTTP | App `ApiError.kind` | When |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | `unauthorized` | missing / invalid / expired / idle / revoked / rotated session; account suspended or being deleted; internal signature refused |
| `MEMBERSHIP_REQUIRED` | 403 | `membership_required` | any member endpoint without ACTIVE_MEMBER + live membership |
| `NOT_ALLOWED` | 403 | `not_allowed` | lifecycle refuses the action (e.g. Stage 2 outside the draft) |
| `VALIDATION_FAILED` | 422 | `validation` | `fields` lists what to fix |
| `NOT_FOUND` | 404 | `not_allowed` | unknown route / internal resource |
| `NOT_AVAILABLE` | 404 | `not_available` | a member you may not see (never introduced, blocked, gone) — one uniform answer |
| `NOT_ELIGIBLE` | 409 | `not_eligible` | introduction withdrawn (block, membership, preferences) |
| `INTRODUCTION_NOT_FOUND` | 404 | `introduction_not_found` | not yours / unknown |
| `INTRODUCTION_EXPIRED` | 410 | `introduction_expired` | an earlier day's introduction |
| `REACTION_ALREADY_RECORDED` | 409 | `reaction_already_recorded` | a different answer to an answered introduction |
| `MATCH_NOT_FOUND` | 404 | `match_not_found` | not an active match of yours |
| `CONVERSATION_FORBIDDEN` | 403 | `conversation_forbidden` | not a participant / match ended / closed / blocked |
| `BLOCKED` | 409 | `blocked` | reserved; blocks are answered as unavailable |
| `RATE_LIMITED` | 429 | `rate_limited` | `retryAfterMs` |
| `INVALID_PHONE` | 422 | `invalid_phone` | malformed, or the SMS provider says the number is invalid |
| `CODE_NOT_SENT` | 503 | `code_not_sent` | the code could not be sent (provider unavailable / limited / rejected / no route); safe to retry; vendor detail is never included |
| `INVALID_CODE` | 422 | `invalid_code` | `attemptsRemaining` |
| `CODE_EXPIRED` | 410 | `code_expired` | expired, consumed, superseded or unknown challenge (unknown reads the same — no enumeration) |
| `TOO_MANY_ATTEMPTS` | 429 | `too_many_attempts` | |
| `PAYLOAD_TOO_LARGE` | 413 | `validation` | |
| `INTERNAL` | 500 | `server` | generic message + request id; never a stack trace, SQL, path or vendor detail |

Transport failures (offline, timeout, 5xx without a body) are `network`
in the app — retryable.

## Authentication

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/otp` | `{ phoneE164 }` | `OtpChallenge { challengeId, phoneE164, expiresAt, resendAvailableAt }` |
| POST | `/auth/otp/verify` | `{ challengeId, code }` | `AuthenticatedApplicant { session: { token, userId }, account, application, membership }` |
| POST | `/auth/sign-out` | — | `{ signedOut: true }` (revokes the presented token; same answer either way) |
| POST | `/auth/sign-out-all` | — | `{ signedOut: true, sessions }` — every device |
| POST | `/auth/session/rotate` | — | `Session { token, userId }` — the old token stops working; presenting it again revokes the family |

`/auth/otp` answers identically whether or not the number has an account.
Suspended or deleted accounts are refused (`NOT_ALLOWED`) only after the
code is proven.

## Account

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/me/deletion` | `{ confirm: true }` | `{ deletionRequested: true }` — idempotent; signs out everywhere, removes the person from every member surface at once, queues anonymization (DATA_RETENTION.md) |

## Admission (the applicant's own application only)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/me/application` | — | `MyApplication { application, membership, summary, informationRequests }` |
| POST | `/application` + `Idempotency-Key` | `Stage1Submission` | `MembershipApplication` (status `APPLICATION_RECEIVED`) |
| POST | `/application/extended/start` | — | `MyApplication` |
| POST | `/application/extended` + `Idempotency-Key` | `Stage2Submission` | `MembershipApplication` (status `FINAL_REVIEW`) |
| PUT | `/application/information-requests/{id}/response` | `InformationResponse` | `MyApplication` |
| POST | `/application/information-update` + `Idempotency-Key` | — | `MyApplication` |
| POST | `/membership/begin` | — | `MyApplication` (status `MEMBERSHIP_PAYMENT_REQUIRED`) |
| GET | `/membership/plans` | — | `MembershipPlan[]` |

Photos are uploaded with the media endpoints below (`APPLICATION_MEDIA`, or
`VERIFICATION_MEDIA` to answer an identity request). In
`MyApplication.informationRequests[].response`, an identity photo appears
only as `{ kind: 'verification_received' }` — never as an image or url.

There is no applicant endpoint that returns anything about members.

## Member (ACTIVE_MEMBER with a live membership)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/member/me` | — | `OwnMember { profile, membership, dating: { usesDating, setupRequired } }` |
| POST | `/member/me/confirm` | — | `OwnMember` (idempotent) |
| PATCH | `/member/me/profile` | `{ occupation?, cityLabel?, knownFor?, interests?, photoOrder? }` | `OwnMember` (a photo left out of `photoOrder` is removed from the profile) |
| GET | `/member/me/dating` | — | `OwnDatingSettings { usesDating, identity, seeking, ageRange, setupCompletedAt }` — own only |
| PUT | `/member/me/dating` | `{ gender, selfDescription?, appearsAs?, seeking, ageRange }` | `OwnDatingSettings` |
| GET | `/member/me/blocked` | — | `BlockedMember[]` |
| GET | `/introductions/today` | — | `IntroductionsView { state, batchId, date, waiting: IntroductionDTO[], hadIntroductions }` |
| POST | `/introductions/{introductionId}/reaction` | `{ type: 'PASS' \| 'LIKE' }` | `ReactionResult { type, match: MatchView \| null }` |
| GET | `/members/{memberId}` | — | `PublicMemberDTO` |
| POST | `/members/{memberId}/block` | — | `{ blocked: true }` (idempotent) |
| POST | `/members/{memberId}/reports` | `{ reason, context, conversationId? }` | `{ reported: true }` |
| GET | `/matches/{matchId}` | — | `MatchView` |
| POST | `/matches/{matchId}/conversation` | — | `ConversationView` (creates on first open; marks read) |
| GET | `/conversations` | — | `ConversationSummary[]` |
| POST | `/conversations/{conversationId}/messages` | `{ body, clientMessageId }` | `ThreadMessage` (idempotent per client message id) |

`OwnMember.membership`: `{ planId, status, startedAt, renewsAt, activation: 'billing' | 'complimentary' }` — an invited membership (DEC-088) has `activation: 'complimentary'` and no `renewsAt`; who started it is never sent.

`IntroductionsView.state`: `READY` · `DATING_SETUP_REQUIRED` · `NOT_USING_DATING`.
`IntroductionDTO`: `{ introductionId, context: 'DATING', member: PublicMemberDTO }`.

### `PublicMemberDTO` (exact keys)

```ts
{ memberId, displayName, age, occupation, cityLabel, knownFor, interests, intents,
  photos: { id, uri /* signed */, width, height }[] }
```

`MemberCard` (lists, match): `{ memberId, displayName, age, occupation, cityLabel, photo }`.

### Reaction semantics

1. The introduction must be the caller's (`INTRODUCTION_NOT_FOUND`).
2. Already answered: the same type replays the original result; a different
   type → `REACTION_ALREADY_RECORDED`. (Replays work after midnight too.)
3. An earlier day → `INTRODUCTION_EXPIRED`.
4. Withdrawn / no longer eligible → `NOT_ELIGIBLE`.
5. Otherwise recorded; a LIKE creates a match only if the other member
   liked the caller AFTER the pair's last ended match (if any) and the pair
   has no ACTIVE match — exactly once, even for simultaneous likes. At most
   one ACTIVE match per pair; ended matches are kept as history (DEC-060).

## Media (direct upload — MEDIA_ARCHITECTURE.md)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/media/uploads` | `CreateUploadRequest { mediaClass: 'APPLICATION_MEDIA' \| 'VERIFICATION_MEDIA' \| 'PROFILE_MEDIA', contentType: 'image/jpeg' \| 'image/png' \| 'image/webp', byteLength, requestId? }` | `UploadAuthorization { uploadId, mediaClass, upload: { url, method: 'PUT', headers }, expiresAt }` |
| PUT | `upload.url` (storage, not the API) | the image bytes, with `upload.headers` | storage's answer; **no Authorization header** |
| POST | `/media/uploads/{uploadId}/complete` | — | `CompletedUpload { uploadId, mediaClass, mediaId, applicationMedia \| null, member \| null }` (idempotent) |

Class rules: `APPLICATION_MEDIA` — extended draft open, or an open
REPLACE_PHOTO request (`requestId`); `VERIFICATION_MEDIA` — an open
VERIFY_IDENTITY request only (`applicationMedia.storageKey` is empty: no url,
ever); `PROFILE_MEDIA` — ACTIVE_MEMBER with a live membership (`member` is
the updated `OwnMember`). Completion answers `VALIDATION_FAILED ['upload']`
while the object is not there yet or after the 10-minute window,
`VALIDATION_FAILED ['photo']` when the content is not the declared image
type, `PAYLOAD_TOO_LARGE` above the authorised size, `NOT_FOUND` for an
upload of another account.

Local development driver only (absent with S3 storage):

| Method | Path | Notes |
|---|---|---|
| PUT | `/storage/upload?b=&k=&ct=&n=&exp=&sig=` | signature over bucket, key, type, length, expiry; `Content-Type` and length must match |
| GET | `/storage/object?b=&k=&exp=&sig=` | signature over bucket, key, expiry; 404 on any mismatch or expiry |

## Internal (`/internal`, signed requests — SECURITY_MODEL.md §5)

Headers `X-Internal-Key-Id`, `X-Internal-Timestamp`, `X-Internal-Nonce`,
`X-Internal-Signature` (HMAC over the environment, method, path+query,
timestamp, nonce and body hash); each key has scopes.

| Method | Path | Scope | Body |
|---|---|---|---|
| GET | `/internal/reviewer/applications?status=A,B&includeQa=true&limit=100` | `review:read` | → `{ applications: ReviewQueueItem[] }` — `{ id, status, firstName, age, city, countryCode, submittedAt, updatedAt, photoCount, actions, canStartInvitedMembership, qa }`; submitted applications of active accounts, oldest change first; no surname, phone, answers or media (DEC-087) |
| GET | `/internal/reviewer/applications/{applicationId}?reviewerId=…` | `review:read` | → `ReviewDetail` — `{ id, status, qa, timeline, applicant { firstName, lastName, dateOfBirth, age, instagram, countryCode, city }, referral { kind, referrers [{ name, status }] }, extended, media [{ id, purpose, type, position, retired, createdAt }], informationRequests, reviews, actions, canStartInvitedMembership, membership }`; never a phone number; every open written to `application_access_log` |
| POST | `/internal/reviewer/applications/{applicationId}/actions` | `review:write` | `{ reviewerId, action: ReviewerAction }` |
| POST | `/internal/reviewer/applications/{applicationId}/media/{mediaId}/access` | `review:media` | `{ reviewerId, purpose: 'REVIEW' \| 'SAFETY' }` → `{ url, expiresInSeconds, mediaClass }` (logged) |
| POST | `/internal/reviewer/applications/{applicationId}/invited-membership` | `membership:complimentary` (absent in production) | `{ reviewerId }` → `MembershipApplication`: APPROVED / MEMBERSHIP_PAYMENT_REQUIRED → ACTIVE_MEMBER, membership `activation: 'complimentary'`, no billing event, no renewal; idempotent for an invited member (DEC-088) |
| POST | `/internal/billing/payment-confirmed` | `billing:write` | `{ accountId, providerEventId, provider }` |
| POST | `/internal/billing/membership-expired` | `billing:write` | `{ accountId, providerEventId, provider }` |
| POST | `/internal/safety/accounts/{accountId}/suspend` | `safety:write` | `{ actorId, reasonCode }` |
| POST | `/internal/safety/accounts/{accountId}/reinstate` | `safety:write` | `{ actorId }` |
| POST | `/internal/safety/accounts/{accountId}/holds` | `safety:write` | `{ actorId, reason: 'SAFETY_REPORT' \| 'INVESTIGATION' \| 'LEGAL_REQUEST' \| 'OTHER' }` → `{ holdId }` |
| POST | `/internal/safety/holds/{holdId}/release` | `safety:write` | `{ actorId }` |
| POST | `/internal/retention/run` | `retention:run` | optional `{ dryRun: boolean }` → `{ dryRun, windows, uploadsExpired, accountsAnonymized, accountsHeld, mediaPurged, authRecordsPurged, safetyRecordsPurged, auditRecordsPurged }` |
| POST | `/internal/media/reconcile` | `media:reconcile` | optional `{ mode: 'dry-run' \| 'repair' }` (default dry run) → `ReconcileReport` (counts, actions, ≤ 200 items with opaque keys/ids) — MEDIA_ARCHITECTURE.md §7 |
| POST | `/internal/test/otp` | `test:otp` (absent in production) | `{ phoneE164 }` → `{ code }` for a designated test number, once |
| POST | `/internal/test/applications/{applicationId}/review` | `test:review` (absent in production) | `{ action: 'START_REVIEW' \| 'REQUEST_EXTENDED' \| 'REQUEST_IDENTITY' \| 'APPROVE' \| 'WAITLIST' \| 'NOT_ADMIT' \| 'ACTIVATE' }` → `MembershipApplication`; QA applications only (others: 404); normal transitions and audit (DEC-076) |
| POST | `/internal/test/applications/lookup` | `test:review` (absent in production) | `{ phoneE164 }` → `{ applicationId, status }` for an active QA account (test numbers or listed project SIMs); anything else 404 (DEC-083) |
| POST | `/internal/test/client-address` | `test:review` (absent in production) | no body → `{ address, privateRange, hops }`: the address the API resolved for the caller. Proves `TRUST_PROXY_HOPS` on a deployment; the staging tools call it as a preflight before any OTP request |

## Health

`GET /health/live` → `{ status: 'ok' }`. `GET /health/ready` →
`{ status: 'ready' | 'not_ready', checks: { database, migrations, storage } }`
(503 when not ready). `GET /health` → `{ ok: true }` (alias of live).

## Versioning

Breaking changes get a new prefix (`/v2`); additive fields are allowed in
`/v1`. The app tolerates unknown fields; the server ignores unknown request
fields (they are never applied).
