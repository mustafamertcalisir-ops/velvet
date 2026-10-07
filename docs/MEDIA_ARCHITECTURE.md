# Media architecture

How photos are uploaded, processed, stored, delivered and removed.
Decisions: DEC-063 (revised 2026-10-06), DEC-067, DEC-073, DEC-075. Code:
server/src/media/{pipeline,objectStore,media,reconcile}.ts,
src/services/http/directUpload.ts. Tests: server/test/media.test.ts,
server/test/security.test.ts, src/services/__tests__/httpAdapters.test.ts,
e2e/production.mjs.

---

## 1. Storage

Private object storage behind one interface (`ObjectStore`):

| Driver | Where | Upload / delivery urls |
|---|---|---|
| `s3` | staging, production — any S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2, GCS interoperability, MinIO) | the provider's own presigned urls (SigV4); the PUT signs `Content-Type` and `Content-Length` |
| `local` | development, test | files on disk; the API serves HMAC-signed `/v1/storage/upload` and `/v1/storage/object` urls (an emulation of the same flow; these routes do not exist with `s3`) |

Two **private** buckets:

| Bucket | Holds |
|---|---|
| `S3_BUCKET` (`media`) | application photos, member photos, incoming uploads for those |
| `S3_VERIFICATION_BUCKET` (`verification`) | identity photos only, and their incoming uploads — a separate bucket so its access policy, logging and lifecycle can be stricter |

Selected for staging (DEC-073): **AWS S3 eu-central-1**, reached through
Render OIDC workload identity. infra/aws/ holds the IAM role policy, the
bucket policies (TLS only, only the API role, presigned age caps of 15 and 10
minutes on media and 2 and 10 minutes on verification), lifecycle, CORS and
logging. Not yet provisioned.

Keys are opaque and never public: `incoming/{yyyymmdd}/{uploadId}.bin`,
`application/{applicationId}/{mediaId}.jpg`,
`verification/{applicationId}/{mediaId}.jpg`, `member/{memberId}/{mediaId}.jpg`
(validated by pattern; no path traversal). Bucket configuration required in
production: block all public access; no public ACLs; server-side encryption
on; a lifecycle rule deleting `incoming/` objects after one day in BOTH
buckets (required — raw uploads still carry their metadata) as a second line
behind the API's own sweep; access logging on the verification bucket
where the provider offers it. These are provider settings, not code — see
docs/STAGING.md.

## 2. Media classes

| Class | Who may upload | Stored | Who may see it | Delivery url |
|---|---|---|---|---|
| `APPLICATION_MEDIA` | the applicant, while the extended draft is open, or to answer an open REPLACE_PHOTO request | `media` / `application/…` | the applicant (own); reviewers | 10 min |
| `VERIFICATION_MEDIA` | the applicant, only to answer an open VERIFY_IDENTITY request | `verification` / `verification/…` | **reviewers only** (`review:media`), every access logged | 2 min |
| `PROFILE_MEDIA` | an ACTIVE_MEMBER with a live membership | `media` / `member/…` | members allowed to see the profile (today's eligible introduction or an active match; never across a block) | 15 min |

Verification media is **never returned by any applicant or member endpoint**
— not even to its owner. The upload answer carries no url
(`storageKey: ''`) and the request shows only `{ kind: 'verification_received' }`;
the app shows the person's own local copy right after taking it, or the
words "Photo received. Only our membership team can see it." Verification
photos are never promoted to a member profile.

## 3. Upload flow

```
client                         API                                     private storage
  │ POST /v1/media/uploads       │                                            │
  │ {mediaClass, contentType,    │ 1 authenticate (session)                   │
  │  byteLength, requestId?}  ──▶│ 2 validate purpose + class rule            │
  │                              │   (rate limit: 40/hour/account)            │
  │                              │ 3 record PENDING upload, presign PUT ──────┼─ type+length signed, 10 min
  │◀── {uploadId, upload:{url,   │                                            │
  │      method:PUT, headers}}   │                                            │
  │ PUT bytes ───────────────────┼───────────────────────────────────────────▶│ incoming/…  (4 direct)
  │ POST …/uploads/{id}/complete▶│ 5 lock upload (own account only), re-check │
  │                              │   the class rule, read object (≤ declared) │
  │                              │ 6 identify by CONTENT (magic bytes) and    │
  │                              │   require it to equal the declared type;   │
  │                              │   decode + re-encode (sharp): orientation  │
  │                              │   applied, ≤ 2048 px, ALL metadata dropped │
  │                              │ 7 store final object ──────────────────────┼─ application/ | verification/ | member/
  │                              │ 8 create media row, mark COMPLETED,        │
  │                              │   delete the incoming object ──────────────┼─ (deleted)
  │◀── {mediaId, applicationMedia│                                            │
  │     | member}                │                                            │
```

- File names and extensions are never used. The declared type must be
  jpeg/png/webp, the content must be that type, and it must decode.
- Completion is idempotent (a retry answers the same media) and safe under
  concurrency (the upload row is locked; a losing racer deletes its copy).
- A rejected upload (not an image, too large, no longer authorised) is
  marked REJECTED and its incoming object deleted at once.
- An upload not completed within 10 minutes is EXPIRED by the retention run
  and its incoming object deleted. Once any upload's url is dead, its
  incoming key is deleted one final time whatever the outcome
  (`incoming_swept_at`) — a still-valid url could have re-created the raw
  object after completion. The local driver also refuses a PUT to an upload
  that is no longer PENDING; with S3 the sweep and the bucket's `incoming/`
  lifecycle rule cover it.
- Completion counts photos under a row lock on the owner (member profile
  or application): concurrent completions cannot exceed the limit or share
  a position (tested).
- The app's HTTP adapters perform the three steps; the PUT carries no
  session (the signature is the only permission). The mock backend keeps
  its in-memory equivalent for development and E2E.

Emulation note: the local driver enforces type, length, key and expiry
itself; **s3rver (used in tests and the staging-shaped rehearsal) does not
validate S3 signatures or lengths** — real S3-compatible services do. The
API re-checks size and content at completion regardless.

## 4. Delivery

- Every url is minted per response, only for a caller the domain rules
  allow at that moment (`createMediaDelivery`): there is no function that
  mints an applicant- or member-facing verification url.
- Bucket, key and expiry are inside the signature: a url cannot be bent to
  another object, bucket or class (tested); an expired url is refused.
- `Cache-Control: private` with a lifetime no longer than the url's.
- Reviewer access (`POST /internal/reviewer/applications/{id}/media/{mediaId}/access`,
  scope `review:media`, body `{ reviewerId, purpose: REVIEW | SAFETY }`)
  writes `media_access_log` (append-only) before returning the url.

## 5. Removal and deletion

| Event | Immediately | Object |
|---|---|---|
| Member removes a profile photo (photo order without it) | `removed_at`, position −1: no longer delivered anywhere | purged after `RETENTION_REMOVED_PROFILE_MEDIA_DAYS` — unset = kept (policy pending); never while the member is under hold or has an open report against them |
| Applicant's photo replaced through REPLACE_PHOTO | `retired_at`: no longer shown or promoted | purged after `RETENTION_RETIRED_APPLICATION_MEDIA_DAYS` (unset = kept) |
| Photos uploaded but left out of the Stage 2 submission | position −1: not part of the profile | kept with the application (policy pending) |
| Verification photo | never shown to anyone but reviewers | purged after `RETENTION_VERIFICATION_MEDIA_DAYS` once the application has left review (unset = kept) |
| Abandoned upload | — | deleted 10 minutes after authorization (always) |
| Account anonymized | — | every application, verification and member object of the account deleted; rows kept with `purged_at`; skipped while a retention hold applies |
| A purged member photo | — | can never return to the profile (photo order only accepts unpurged photos) |

Purges delete the object first, then mark the row, inside one transaction —
a failed deletion leaves the row unmarked for the next run. Safety-relevant
media is never destroyed automatically without a configured window, and
holds always win (DEC-067, docs/DATA_RETENTION.md).

## 6. Not built yet (see also §7–8)

- Short video (modelled as `type: 'video'`, not accepted).
- Automated moderation of images (`moderation_status` exists; review is manual).
- A CDN in front of delivery (signed urls work with one later).
- Client-side resumable uploads (photos are ≤ 1080 px JPEG before upload, well under the 8 MiB limit).

## 7. Reconciliation (DEC-075)

`POST /internal/media/reconcile` (scope `media:reconcile`), or
`node dist/ops.mjs reconcile [--repair]`, lists both buckets page by page
(`ObjectStore.list` → ListObjectsV2) and compares them with
`media_uploads`, `application_media` and `member_media`. It runs as a **dry
run unless `repair` is asked for**.

| Category | Meaning | repair |
|---|---|---|
| `ORPHANED_INCOMING` | a raw upload no live upload can use (no row; finished, rejected or expired upload; url dead), older than the upload lifetime + 15 min | deleted — never evidence: unprocessed, still carries metadata |
| `FAILED_DELETION` | the database already purged the media, or swept the upload, but the object is there | deleted — the database decision stands |
| `UNREFERENCED` | a processed object in the media bucket that no row references | deleted only if older than 24 h |
| `UNREFERENCED_VERIFICATION` | an object in the verification bucket with no row | **never deleted** — NEEDS_REVIEW: possibly identity evidence whose record is missing |
| `MISSING_OBJECT` | a live row whose object is absent (rows older than 15 min) | **report only** — data loss to investigate; rows are never edited to hide it |
| `UNKNOWN_KEY` | a key outside the scheme | report only |

- **Holds always win.** Nothing tied to an account under an active retention
  hold is deleted (`KEPT_HELD`). The account is found from the upload row,
  the media row, or the owner id in the key.
- **Young objects** (`KEPT_YOUNG`) are left alone: an upload or a completion
  may be in flight. An upload still in progress (PENDING, not expired) is
  never even reported.
- **The report** holds counts, actions and at most 200 items, ordered most
  actionable first. Items carry opaque keys and ids, never personal data.
  The log line carries counts only.
- **Scale.** At most 200,000 objects are listed per bucket per run. Past
  that, the report says `complete: false` and MISSING_OBJECT is not
  evaluated, because it would give false positives.
- **Tests:** server/test/reconcile.test.ts (every category, dry run, repair,
  holds, an upload in progress, scopes). The rehearsal runs it against S3
  (s3rver).

## 8. Verification against the real provider

server/test/storage.provider.test.ts (`npm run test:storage:provider`) runs
only with real staging bucket credentials (`STORAGE_PROVIDER_TEST=1`). Without
them every case is reported as **BLOCKED**, never emulated. In CI it runs as
`velvet-staging-storage-test`, assumed with GitHub's OIDC token and limited to
test-shaped keys (DEC-082; Actions → `staging-checks` → `storage`), together
with e2e/storage-cors.mjs: a real Chromium uploads to a presigned URL from the
staging web origin (allowed) and from another origin (refused); with no web
origin configured the bucket has no CORS rule and every browser origin is
refused. It checks:
- a signed upload works in both buckets;
- an expired or altered signature is refused;
- a different content type, or a longer or shorter body than signed, is
  refused;
- unsigned reads are refused;
- a signed read works, then expires;
- a read URL cannot be bent to another key or bucket;
- copy, list and delete;
- CORS: only the staging web origin may PUT.

The staging suite checks the rest through the deployed API:
- EXIF and GPS are gone from stored photos;
- verification media never appears in responses.

**Storage stays unverified until both have passed against the real
buckets.** AWS documents no explicit enforcement of signed `Content-Length`
and `Content-Type` (NOT CONFIRMED); this test is what proves it.
