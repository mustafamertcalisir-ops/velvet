# Security model

How every request is authenticated and authorised, how internal callers
prove who they are, how abuse is limited, and what is logged. Decisions:
DEC-061, DEC-062, DEC-064, DEC-066, DEC-069, DEC-070. Code:
server/src/http/{endpoints,app,internalAuth}.ts, server/src/auth/service.ts,
server/src/ratelimit.ts, server/src/lib/log.ts. Tests:
server/test/security.test.ts (and auth, account, media, member, privacy).

---

## 1. Principals

| Principal | Credential | Can reach |
|---|---|---|
| Anyone | none | health, `POST /v1/auth/otp`, `POST /v1/auth/otp/verify` |
| Signed-in person (applicant or member) | bearer session token | their own account, application and — when ACTIVE_MEMBER with a live membership — the member API |
| Holder of a signed storage url | the url's signature | exactly one object, until it expires |
| Internal caller (review tooling, billing adapter, retention job, smoke runner) | a signed request with a scoped key | only the internal endpoints its scopes allow |

A session can never act as an internal caller, and an internal key can never
act as a person.

## 2. The policy registry

Every route is declared once in `server/src/http/endpoints.ts` with:
authentication (`none`, `session`, `token-optional`, `signed-url`,
`internal` + scope), membership requirement (`NONE`, `ACCOUNT`,
`APPLICATION`, `ACTIVE_MEMBER`, `BY_MEDIA_CLASS`), ownership, the
authorization rule, request validation, the response DTO, the typed errors
and the rate limits. The HTTP layer registers routes **from** this list and
picks the authentication middleware from `auth`/`scope` — never from the
path. Membership, ownership and authorization are decided inside each
service operation, in the same database transaction as the work.

Enforced by tests that iterate the registry (not a hand-picked list):
- every contract route has a policy with the same method and path;
- every `session` endpoint answers 401 without a token, with a malformed
  token and with an unknown token;
- every `ACTIVE_MEMBER` endpoint answers 403 MEMBERSHIP_REQUIRED to an applicant;
- every `internal` endpoint answers 401 to a member session, to an unsigned
  call and to a key without its scope;
- test-only and local-storage endpoints are absent where they must be;
- the table at the end of this file equals the registry (`npm run docs:security`).

## 3. Sessions (DEC-066)

256-bit random bearer tokens; only SHA-256 hashes are stored. Absolute
expiry 60 days, idle expiry 30 days. Sign out, sign out everywhere,
rotation with reuse detection (a rotated token presented again revokes its
family); rotation keeps the family's absolute expiry, so it never extends a
session's life. Suspension and deletion requests revoke every session; a
non-active account is refused on every request. Expired, revoked, rotated,
suspended and deleted sessions are tested.

## 4. One-time codes (DEC-061)

Random six digits, HMAC-stored, 10 minutes, 5 attempts, single use (replay
refused, concurrent duplicates yield one session), 30-second resend
cooldown, 5 codes per number per hour, 30 per address per hour, 60
verifications per address and 20 per number per hour. Requests read the
same for known and unknown numbers; wrong codes read the same; an invented
challenge reads like an expired one. A suspended or deleted account is
refused only after proof of possession.

## 5. Internal requests (DEC-070)

```
X-Internal-Key-Id     key id (one per caller)
X-Internal-Timestamp  unix seconds, accepted within ±300 s
X-Internal-Nonce      16–128 url-safe chars, single use per key (stored; replay → 401)
X-Internal-Signature  base64url HMAC-SHA256(secret,
                        ENV \n METHOD \n PATH?QUERY \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY))
```

`ENV` is the API's `APP_ENV`: a request signed for staging is refused by
production even if a key were mistakenly shared (each database keeps its
own nonce table, so the environment must be inside the signature).

Scopes: `review:read`, `review:write`, `review:media`, `billing:write`,
`safety:write`, `retention:run`, `media:reconcile`, and the staging/test-only
`test:otp`, `test:review` and `membership:complimentary` (refused in
production by configuration; their routes are not even registered there).
The staging runner key holds only `test:otp test:review`: the review fixture
acts on QA accounts only (DEC-076), so that key can never decide about a real
applicant. The staging `reviewer` key (DEC-087) belongs to the membership
team's tool on the owner's computer: `review:read review:write review:media
membership:complimentary`. `review:read` never returns a phone number, and
every application view it serves is written to `application_access_log`. Keys rotate by
adding a new id and removing the old. Every refusal is logged with the
reason (MISSING, UNKNOWN_KEY, STALE, BAD_SIGNATURE, SCOPE, REPLAY) and the
key id — never the signature.

Network restriction (DEC-073 §1.1): `INTERNAL_ALLOWED_CIDRS` optionally
requires the caller's address (setting it on staging would also shut out the
owner's review tool, which calls from a home connection) — resolved with `TRUST_PROXY_HOPS`, so a
spoofed `X-Forwarded-For` does not help — to fall in listed ranges, refused
with reason NETWORK. It is never a substitute for the signature: both
apply. On Render Pro, `/internal/*` is reachable from the internet (an
inbound IP allow list needs the Scale plan); a Render private service for
internal routes is the stronger later option.

The signed path is the path the API sees; a proxy that rewrites paths must
be configured so that callers sign the rewritten path.

## 6. Input handling

- JSON bodies are limited to 64 KiB (the local storage upload to 8 MiB);
  larger bodies answer 413 before they are read, with `Connection: close`
  so the half-sent body never poisons a reused connection (DEC-080).
- Malformed JSON and wrong shapes answer 422 VALIDATION_FAILED — never 500.
- Every query is parameterised; identifiers from the path are opaque strings
  compared by value (injection attempts are inert — tested).
- Images: identified by content, re-encoded, size- and pixel-bounded
  (docs/MEDIA_ARCHITECTURE.md).

## 7. Rate limits (DEC-062)

| Limit | Window |
|---|---|
| OTP requests per number / per address | 5 / 30 per hour (+ 30 s cooldown) |
| OTP verifications per address / per number | 60 / 20 per hour (+ 5 per code) |
| Reactions | 200 per hour |
| Messages | 30 per minute, 1000 per day |
| Reports | 20 per day |
| Profile updates | 60 per hour |
| Upload authorizations | 40 per hour |
| Dating settings | 30 per hour |
| Account-deletion requests | 5 per hour |

Stored in PostgreSQL (`rate_limit_events`), serialised per subject with an
advisory lock — shared by every API instance (tested with two instances).
The client address is the socket address or, behind `TRUST_PROXY_HOPS`
proxies, the X-Forwarded-For entry our own proxy appended; entries a client
adds cannot change it.

## 8. Errors and logs (DEC-069)

- Errors are typed codes with a short message and the request id. Unexpected
  failures answer `INTERNAL` with a generic message; SQL, paths, stack
  traces, vendor responses and secrets never reach the client (tested by
  breaking a table mid-request).
- Logs are JSON lines with the request id; a redactor removes sensitive keys
  at any depth and masks phone numbers in free text. Never logged: OTP
  codes, session tokens, full phone numbers, dates of birth, signed or
  verification urls, Dating settings, reviewer notes, request bodies.
- `X-Request-Id`: a well-formed inbound id (8–64 url-safe chars, e.g. from
  the edge) is kept; anything else is replaced.

## 9. Health

`GET /health/live` → `{ status: "ok" }`. `GET /health/ready` →
`{ status: "ready" | "not_ready", checks: { database, migrations, storage } }`
with values `ok | fail | mismatch` only — no versions, hosts, counts or data;
503 when not ready.

## 10. Known gaps

- No WAF / bot protection in front of the API (a deployment choice).
- `/internal/*` is internet-reachable on the selected platform plan; only the
  optional address allow list narrows it (§5).
- Signed internal requests protect integrity and replay, not confidentiality
  of the body — the transport must be TLS.
- Device integrity (App Attest / Play Integrity) is not used.
- Screen-capture prevention is not claimed (PRIVACY_BOUNDARIES §8).

## 11. Endpoint matrix

<!-- endpoint-matrix:begin (generated by `npm run docs:security` from server/src/http/endpoints.ts — do not edit by hand) -->

| Endpoint | Auth | Membership | Ownership | Authorization | Validation | Response | Errors | Rate limits | Policy id |
|---|---|---|---|---|---|---|---|---|---|
| `GET /health/live` | none | NONE | None. | Public. Answers only that the process is serving. | None. | { status } | — | — | `health.live` |
| `GET /health/ready` | none | NONE | None. | Public. Reports pass/fail per dependency only — no versions, hosts, counts or data. | None. | { status, checks: { database, migrations, storage } } | — | — | `health.ready` |
| `GET /health` | none | NONE | None. | Public. Alias of /health/live. | None. | { ok } | — | — | `health` |
| `POST /v1/auth/otp` | none | NONE | None. The answer is identical whether or not the number has an account. | Public. | phoneE164 matches E.164. | OtpChallenge | VALIDATION_FAILED, INVALID_PHONE, RATE_LIMITED, CODE_NOT_SENT, PAYLOAD_TOO_LARGE, INTERNAL | otpRequestPerIp, otpRequestPerPhone, 30 s resend cooldown per number | `auth.requestOtp` |
| `POST /v1/auth/otp/verify` | none | NONE | The challenge’s number only. | Proof of possession of the code. Suspended / deleted accounts are refused after proof. | challengeId (≤ 100 chars), code (6 digits). | AuthenticatedApplicant | VALIDATION_FAILED, INVALID_CODE, CODE_EXPIRED, TOO_MANY_ATTEMPTS, RATE_LIMITED, NOT_ALLOWED, PAYLOAD_TOO_LARGE, INTERNAL | otpVerifyPerIp, otpVerifyPerPhone, 5 attempts per code | `auth.verifyOtp` |
| `POST /v1/auth/sign-out` | token-optional | NONE | The presented token only. | Revokes the presented token if it is valid; always answers the same. | Bearer token format. | { signedOut } | INTERNAL | — | `auth.signOut` |
| `POST /v1/auth/sign-out-all` | session | ACCOUNT | The caller’s own account (from the session; never from the request). | Revokes every live session of the caller’s account. | None. | { signedOut, sessions } | UNAUTHENTICATED, INTERNAL | — | `auth.signOutEverywhere` |
| `POST /v1/auth/session/rotate` | session | ACCOUNT | The presented session only. | A live session is exchanged once; reuse of a rotated token revokes the whole session family. | Bearer token format. | Session | UNAUTHENTICATED, INTERNAL | — | `auth.rotateSession` |
| `POST /v1/me/deletion` | session | ACCOUNT | The caller’s own account (from the session; never from the request). | Any signed-in person may delete their own account. Idempotent. | { confirm: true }. | { deletionRequested } | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL | accountDeletionPerAccount | `account.requestDeletion` |
| `POST /v1/media/uploads` | session | BY_MEDIA_CLASS | The caller’s own application (APPLICATION_MEDIA, VERIFICATION_MEDIA) or member profile (PROFILE_MEDIA). | APPLICATION_MEDIA: extended draft open, or an open REPLACE_PHOTO request. VERIFICATION_MEDIA: an open VERIFY_IDENTITY request. PROFILE_MEDIA: ACTIVE_MEMBER with a live membership. | mediaClass, contentType (jpeg/png/webp), byteLength (1 B – 8 MiB), requestId. | UploadAuthorization (10-minute signed PUT url; type and length signed) | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, NOT_ALLOWED | mediaUploadPerAccount | `media.createUpload` |
| `POST /v1/media/uploads/:id/complete` | session | BY_MEDIA_CLASS | Uploads created by the caller’s account only (others answer NOT_FOUND). | Re-checked at completion: the class rule must still hold. | Object present, ≤ authorised size, content sniffed as the declared image type, decodable; re-encoded without metadata. | CompletedUpload | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, NOT_ALLOWED, NOT_FOUND | — | `media.completeUpload` |
| `PUT /v1/storage/upload` (local storage driver only) | signed-url | NONE | Exactly the object key in the signed url. | HMAC signature over method, bucket, key, content type, length and expiry (local storage driver only). | Signature, expiry, Content-Type equals the signed type, body length equals the signed length. | { stored } | NOT_FOUND, VALIDATION_FAILED, PAYLOAD_TOO_LARGE | — | `storage.upload` |
| `GET /v1/storage/object` (local storage driver only) | signed-url | NONE | Exactly the object key in the signed url. | HMAC signature over method, bucket, key and expiry (local storage driver only). | Signature and expiry (≤ 15 minutes ahead). | image/jpeg bytes | NOT_FOUND | — | `storage.object` |
| `GET /v1/me/application` | session | ACCOUNT | The caller’s own application only (looked up by the session’s account). | Own application; summary never includes the date of birth. | None. | MyApplication | UNAUTHENTICATED, INTERNAL | — | `admission.mine` |
| `POST /v1/application` | session | ACCOUNT | The caller’s own account (from the session; never from the request). | One application per account; submission moves only to APPLICATION_RECEIVED. | Idempotency-Key; validateStage1Submission (names, DOB 18+, Instagram, country, city, referral). | MembershipApplication | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL | — | `admission.submitStage1` |
| `POST /v1/application/extended/start` | session | APPLICATION | The caller’s own application only (looked up by the session’s account). | Only from EXTENDED_APPLICATION_REQUIRED (idempotent once started). | None. | MyApplication | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, NOT_ALLOWED | — | `admission.startExtended` |
| `POST /v1/application/extended` | session | APPLICATION | The caller’s own application only (looked up by the session’s account). | Only from EXTENDED_APPLICATION_DRAFT; photos must be the applicant’s own; moves to FINAL_REVIEW, never a decision. | Idempotency-Key; validateStage2Submission. | MembershipApplication | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, NOT_ALLOWED | — | `admission.submitStage2` |
| `PUT /v1/application/information-requests/:id/response` | session | APPLICATION | Requests of the caller’s own application only. | Only in MORE_INFORMATION_REQUIRED; the answer touches only the request’s own target. | validateResponse (type matches the request; media uploaded for this request). | MyApplication | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, NOT_ALLOWED | — | `admission.respondToRequest` |
| `POST /v1/application/information-update` | session | APPLICATION | The caller’s own application only (looked up by the session’s account). | Every open request answered; returns to the review stage it came from. | Idempotency-Key. | MyApplication | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, NOT_ALLOWED | — | `admission.submitInformationUpdate` |
| `POST /v1/membership/begin` | session | APPLICATION | The caller’s own application only (looked up by the session’s account). | Only from APPROVED; moves to MEMBERSHIP_PAYMENT_REQUIRED, never ACTIVE_MEMBER. | None. | MyApplication | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, NOT_ALLOWED | — | `admission.beginMembership` |
| `GET /v1/membership/plans` | session | APPLICATION | Public plan data. | Only in APPROVED or MEMBERSHIP_PAYMENT_REQUIRED. | None. | MembershipPlan[] | UNAUTHENTICATED, NOT_ALLOWED, INTERNAL | — | `admission.membershipPlans` |
| `GET /v1/member/me` | session | ACTIVE_MEMBER | The caller’s own member profile only (looked up by the session’s account). | Membership checked in the same transaction. | None. | OwnMember | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED | — | `member.me` |
| `POST /v1/member/me/confirm` | session | ACTIVE_MEMBER | The caller’s own member profile only (looked up by the session’s account). | Membership. | None. | OwnMember | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED | — | `member.confirmProfile` |
| `PATCH /v1/member/me/profile` | session | ACTIVE_MEMBER | The caller’s own member profile only (looked up by the session’s account). | Only public profile fields; application records untouched; photo order only over own, unpurged photos. | Types, then validateMemberProfilePatch. | OwnMember | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED | profileUpdatePerMember | `member.updateProfile` |
| `GET /v1/member/me/dating` | session | ACTIVE_MEMBER | The caller’s own member profile only (looked up by the session’s account). | Own private Dating settings only (never on any other member’s read). | None. | OwnDatingSettings | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED | — | `member.datingSettings` |
| `PUT /v1/member/me/dating` | session | ACTIVE_MEMBER | The caller’s own member profile only (looked up by the session’s account). | Only members who joined for Dating. | validateDatingSettingsInput. | OwnDatingSettings | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, NOT_ALLOWED | datingSettingsPerMember | `member.saveDatingSettings` |
| `GET /v1/member/me/blocked` | session | ACTIVE_MEMBER | Blocks the caller made. | Membership. | None. | BlockedMember[] | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED | — | `member.blocked` |
| `GET /v1/introductions/today` | session | ACTIVE_MEMBER | The caller’s own batch. | Dating members with completed setup; candidates pass the shared eligibility function (mutual preferences, blocks, membership, history). | None. | IntroductionsView | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED | — | `member.introductionsToday` |
| `POST /v1/introductions/:id/reaction` | session | ACTIVE_MEMBER | Introductions addressed to the caller only (others: INTRODUCTION_NOT_FOUND). | Today’s introduction, still eligible; one reaction per introduction; one ACTIVE match per pair. | type ∈ {LIKE, PASS}. | ReactionResult | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, INTRODUCTION_NOT_FOUND, INTRODUCTION_EXPIRED, REACTION_ALREADY_RECORDED, NOT_ELIGIBLE | reactionPerMember | `member.react` |
| `GET /v1/members/:id` | session | ACTIVE_MEMBER | Another member’s PUBLIC profile only. | Introduced today (still eligible) or actively matched; never across a block. | None. | PublicMemberDTO | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, NOT_AVAILABLE | — | `member.member` |
| `POST /v1/members/:id/block` | session | ACTIVE_MEMBER | The caller blocks someone they can see. | Visible to the caller (or already blocked). Ends an active match (BLOCKED) and closes its conversation. | None. | { blocked } | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, NOT_AVAILABLE | — | `member.block` |
| `POST /v1/members/:id/reports` | session | ACTIVE_MEMBER | A member the caller can see or has blocked; only a conversation between the two can be attached. | Membership + visibility. | reason, context, optional conversationId. | { reported } | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, NOT_AVAILABLE | reportPerMember | `member.report` |
| `GET /v1/matches/:id` | session | ACTIVE_MEMBER | Matches the caller is part of. | ACTIVE match, both sides active, no block. | None. | MatchView | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, MATCH_NOT_FOUND | — | `member.match` |
| `POST /v1/matches/:id/conversation` | session | ACTIVE_MEMBER | Matches the caller is part of. | ACTIVE match only; creates the conversation once. | None. | ConversationView | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, MATCH_NOT_FOUND | — | `member.openConversation` |
| `GET /v1/conversations` | session | ACTIVE_MEMBER | The caller’s active matches. | Membership. | None. | ConversationSummary[] | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED | — | `member.conversations` |
| `POST /v1/conversations/:id/messages` | session | ACTIVE_MEMBER | Conversations the caller participates in. | canSendMessage: participant, ACTIVE match, other side active, conversation open, no block. | clientMessageId, validateMessage (text, 1–2000). | ThreadMessage | UNAUTHENTICATED, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE, INTERNAL, MEMBERSHIP_REQUIRED, CONVERSATION_FORBIDDEN | messagePerMinute, messagePerDay | `member.sendMessage` |
| `GET /internal/reviewer/applications` | internal (review:read) | NONE | Submitted applications of active accounts (QA accounts only with includeQa=true). | Read-only. The minimum to recognise a person — first name, age, city — plus the status and the reviewer actions open in it. No surname, phone number, answers or media. | Optional query: status (comma-separated non-transient statuses), includeQa (true\|false), limit (1–200, default 100); no other keys. | { applications: ReviewQueueItem[] } (oldest change first) | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.reviewQueue` |
| `GET /internal/reviewer/applications/:id` | internal (review:read) | NONE | Any submitted application of an account that is not being deleted. | Every open written to application_access_log (key id + reviewer id). Never a phone number (the applicant’s or a referrer’s); media as ids only — each photo is opened through review:media. | Query: reviewerId (required); no other keys. | ReviewDetail | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.reviewApplication` |
| `POST /internal/reviewer/applications/:id/actions` | internal (review:write) | NONE | Any application. | planReviewerAction (shared lifecycle); audited with the reviewer id. | reviewerId, action. | MembershipApplication | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.reviewerAction` |
| `POST /internal/reviewer/applications/:id/media/:mediaId/access` | internal (review:media) | NONE | Media of that application. | Every access written to media_access_log; verification urls live 2 minutes. | reviewerId, purpose ∈ {REVIEW, SAFETY}. | { url, expiresInSeconds, mediaClass } | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.reviewerMedia` |
| `POST /internal/reviewer/applications/:id/invited-membership` (absent in production) | internal (membership:complimentary) | NONE | That application’s account. | Staging only (scope refused in production, route absent there). Only from APPROVED or MEMBERSHIP_PAYMENT_REQUIRED of an active account; the normal lifecycle and audit (actor: the reviewer). Membership marked complimentary with the reviewer who started it; no billing event, no renewal. Idempotent for an invited member. | reviewerId; no other keys. | MembershipApplication | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.invitedMembership` |
| `POST /internal/billing/payment-confirmed` | internal (billing:write) | NONE | The account named by the provider event. | Only from MEMBERSHIP_PAYMENT_REQUIRED; once per provider event id. | accountId, providerEventId, provider. | MembershipApplication | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.paymentConfirmed` |
| `POST /internal/billing/membership-expired` | internal (billing:write) | NONE | The account named by the provider event. | Only from ACTIVE_MEMBER; once per provider event id. | accountId, providerEventId, provider. | MembershipApplication | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.membershipExpired` |
| `POST /internal/safety/accounts/:id/suspend` | internal (safety:write) | NONE | Any account. | active → suspended; every session revoked; audited. | actorId, reasonCode. | { accountStatus, sessionsRevoked } | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.suspend` |
| `POST /internal/safety/accounts/:id/reinstate` | internal (safety:write) | NONE | Any account. | suspended → active; audited. | actorId. | { accountStatus } | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.reinstate` |
| `POST /internal/safety/accounts/:id/holds` | internal (safety:write) | NONE | Any account. | Keeps the account’s records out of anonymization and purges; audited. | actorId, reason. | { holdId } | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.placeHold` |
| `POST /internal/safety/holds/:id/release` | internal (safety:write) | NONE | Any hold. | Audited. | actorId. | { released } | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.releaseHold` |
| `POST /internal/retention/run` | internal (retention:run) | NONE | System-wide. | Applies the configured retention policy; holds respected. dryRun: counts only, nothing changed. | Optional { dryRun: boolean }; no other keys. | RetentionReport (counts and configured windows only) | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.retentionRun` |
| `POST /internal/media/reconcile` | internal (media:reconcile) | NONE | System-wide (both buckets). | Dry run by default; one run at a time. repair deletes only raw uploads no live upload can use, objects the database already purged, and unreferenced media-bucket objects older than a day; never a verification object without a record, never anything under a retention hold. | Optional { mode: 'dry-run' \| 'repair' }; no other keys. | ReconcileReport (counts, opaque keys and ids only) | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.mediaReconcile` |
| `POST /internal/test/client-address` (absent in production) | internal (test:review) | NONE | The caller’s own address only. | Staging/test only (scope refused in production, route absent there). Verifies TRUST_PROXY_HOPS on a deployment; the staging tools also use it as a preflight before any OTP request. | None. | { address, privateRange, hops } | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.testClientAddress` |
| `POST /internal/test/applications/:id/review` (absent in production) | internal (test:review) | NONE | QA applications only (accounts from designated test numbers); any other id answers NOT_FOUND. | Staging/test only (scope refused in production, route absent there). Normal reviewer transition validation and audit; activation through the normal payment-confirmed path. | action: START_REVIEW \| REQUEST_EXTENDED \| REQUEST_IDENTITY \| APPROVE \| WAITLIST \| NOT_ADMIT \| ACTIVATE. | MembershipApplication | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.testReview` |
| `POST /internal/test/applications/lookup` (absent in production) | internal (test:review) | NONE | Active QA accounts only (designated test numbers or listed project SIMs); any other number answers NOT_FOUND. | Staging/test only (scope refused in production, route absent there). Read-only: the application id and status of a QA number, for the reviewer side of a real-SIM journey. | phoneE164. | { applicationId, status } | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.testLookup` |
| `POST /internal/test/otp` (absent in production) | internal (test:otp) | NONE | Designated TEST numbers only (SMS_TEST_NUMBERS). | Staging/test only (scope refused in production, route absent there); each code readable once. | phoneE164. | { code } | UNAUTHENTICATED, VALIDATION_FAILED, NOT_FOUND, NOT_ALLOWED, INTERNAL | — | `internal.testOtp` |

<!-- endpoint-matrix:end -->
