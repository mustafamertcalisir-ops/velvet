# Data retention

How long each kind of data lives, what happens to it when a person deletes
their account, and which records may need to outlive an account for safety
or legal reasons. Decisions: DEC-066 (account lifecycle), DEC-067 (retention
semantics), DEC-063 (media), DEC-064 (privacy boundaries).

**No legal retention period is stated or assumed in this document.** Where a
duration matters, it is a policy decision that has not been made yet; the
system exposes it as configuration (`RETENTION_*`, server/.env.example) and,
until it is set, never purges that class automatically. Nothing here is
legal advice; the policy must be set with qualified counsel for Türkiye
(and any other market) before launch.

---

## 1. Six different things called "deletion"

| Term | Meaning here | Where it happens |
|---|---|---|
| **User-visible deletion** | The thing disappears from every surface for everyone (a removed photo, a closed conversation, a hidden profile). The record may still exist. | Immediately, in the request that causes it. |
| **Account deletion** | The person's request to leave. Takes effect at once: signed out everywhere, out of discovery, matches ended, messaging closed, membership cancelled. Queues the account for anonymization. | `POST /v1/me/deletion` (DEC-066). |
| **Anonymization** | Identity and private data are removed; opaque ids stay so that records other people depend on remain consistent. The phone number is released (it can sign up again as a new person). | The retention process (`POST /internal/retention/run`), after the grace window, unless a hold applies. |
| **Physical deletion** | Rows or stored objects are destroyed. | The retention process, for each class whose window is configured; immediately for operational artifacts. |
| **Legal / safety retention** | A record is kept beyond account deletion because another person's safety, an investigation or a legal request may depend on it. Kept without identity where possible, and only under policy. **Retention holds** (`retention_holds`) block anonymization and purges for one account while an investigation or request is open. | Policy + holds (internal `safety:write`). |
| **Audit retention** | The append-only trail of what changed and who changed it. Never edited; deleted only by the retention process under its own window. | `audit_events`, `media_access_log`, `application_access_log`. |

Database guarantees (migration 0008): blocks, reports and messages cannot be
deleted by ordinary statements, and audit logs cannot be updated or
truncated. Only a transaction that marks itself as the retention process
(`SET LOCAL app.retention_purge = 'on'`) can delete them — tested.

## 2. Account deletion, step by step

**At the request (one transaction):**
1. `accounts.account_status = deletion_requested`, `deletion_requested_at` set.
2. Every session revoked (`DELETION_REQUESTED`); sign-in is refused afterwards.
3. Member profile `visibility = hidden` → out of discovery and every other member's view.
4. Waiting introductions in either direction → `WITHDRAWN`; no new ones (the eligibility check requires an active account).
5. ACTIVE matches → `ENDED` (`ACCOUNT_DELETED`); their conversations closed → no new message either way.
6. Membership → `cancelled` (the future billing adapter must also stop billing at the provider).
7. Audit event `ACCOUNT_DELETION_REQUESTED`.

**At anonymization (retention process, one transaction per account; skipped while a hold is active):**
- deleted: application private data (names, date of birth, Instagram, city answer, written answers), referrals, Dating answers on the application, Dating settings, idempotency keys, sessions, one-time-code challenges for the number, staging test-outbox rows, rate-limit counters keyed by the number or account; answers to information requests (`response` cleared);
- media objects deleted (application, verification, member photos, and the incoming object of every upload of the account whatever its status), rows marked `purged_at`;
- membership cancelled if it was not already (a late provider confirmation can never re-activate it);
- member profile reduced to a hidden placeholder: display name "Former member", every descriptive field cleared, `deleted_at` set;
- account: phone number and verification time cleared, `account_status = anonymized`;
- kept, pointing only at opaque ids: the application's lifecycle row and review history, audit events, matches, introductions and reactions (pair history), blocks, reports, messages in closed conversations, billing events;
- audit event `ACCOUNT_ANONYMIZED`.

`ACCOUNT_DELETION_GRACE_HOURS` (default 0) is the delay between request and
anonymization — an undo window if the product decides to offer one
(**undecided**). Tests: server/test/account.test.ts.

## 3. Data families

Legend — **Safety/legal retention**: whether the class may need to be kept
after account deletion. **Duration**: "undecided" means no automatic purge
until the policy sets a window.

### Account
- **Purpose:** the identity a phone number proves; the anchor for every record.
- **Visibility:** the person themselves; the membership team. Never other members.
- **Active use:** sign-in, authorization, lifecycle state.
- **After account deletion:** row kept as an opaque id; phone and verification time cleared at anonymization; status `anonymized`.
- **Safety/legal retention:** the opaque row only (referential integrity for retained records).
- **Anonymization possible:** yes — implemented.
- **Duration:** row kept while any record points to it; physical deletion of fully orphaned rows is **undecided**.

### Phone authentication records (`otp_challenges`, `sms_test_outbox`, OTP rate-limit counters)
- **Purpose:** prove possession of a number; limit abuse.
- **Visibility:** nobody (only a keyed hash of each code is stored; codes are never logged).
- **Active use:** 10 minutes per challenge; rate-limit windows up to 1 hour.
- **After account deletion:** challenges and counters for the number deleted at anonymization.
- **Safety/legal retention:** possibly (abuse investigations) — policy **undecided**.
- **Anonymization possible:** not meaningful; deletion instead.
- **Duration:** challenges: `RETENTION_AUTH_RECORDS_DAYS` (**undecided**); test outbox: until expiry (operational, always purged); rate-limit events: purged after 2 days by every retention run (operational).

### Sessions
- **Purpose:** keep a device signed in.
- **Visibility:** the device holds the token; the server holds only its SHA-256 hash.
- **Active use:** until revoked, idle 30 days or 60 days old.
- **After account deletion:** revoked at the request; rows deleted at anonymization.
- **Safety/legal retention:** possibly (security investigations) — **undecided**.
- **Anonymization possible:** not meaningful; deletion instead.
- **Duration:** revoked/expired rows: `RETENTION_AUTH_RECORDS_DAYS` (**undecided**).

### Membership application (`membership_applications`, `information_requests`, `idempotency_keys`)
- **Purpose:** the admission lifecycle (status and its timestamps), the requests the team made.
- **Visibility:** the applicant sees their own status and requests; the membership team sees all.
- **Active use:** throughout admission; status remains the authority for membership.
- **After account deletion:** lifecycle row kept (no personal data in it); answers to information requests cleared; idempotency keys deleted.
- **Safety/legal retention:** the decision history may be needed (e.g. a re-application by someone previously not admitted) — **undecided**.
- **Anonymization possible:** yes — the row carries no identity once private data is gone.
- **Duration:** **undecided**.

### Private application data (`application_private_data`, `application_referrals`, `application_dating_preferences`)
- **Purpose:** the review: names, date of birth, Instagram, city, work, written answers, referral names and numbers, Dating answers.
- **Visibility:** the applicant (own); the membership team. Never other members (DEC-064).
- **Active use:** during review; age is derived from the date of birth for the life of the membership.
- **After account deletion:** deleted at anonymization.
- **Safety/legal retention:** not by default; a hold keeps it while an investigation is open.
- **Anonymization possible:** deletion is used (the data is the identity).
- **Duration:** while the account exists; NOT_ADMITTED / never-completed applications: **undecided**.

### Application media (`application_media`, purpose `profile`)
- **Purpose:** photos for review; promoted (copied) to the member profile at activation.
- **Visibility:** the applicant (signed, 10 min); reviewers (signed, logged).
- **Active use:** review; replaced photos are `retired_at` and no longer shown.
- **After account deletion:** objects deleted at anonymization; rows kept with `purged_at`.
- **Safety/legal retention:** possibly, if reported content is involved (hold).
- **Anonymization possible:** objects are deleted; rows carry no image.
- **Duration:** retired photos: `RETENTION_RETIRED_APPLICATION_MEDIA_DAYS` (**undecided**).

### Verification media (`application_media`, purpose `verification`)
- **Purpose:** confirm identity when the team asks (VERIFY_IDENTITY).
- **Visibility:** **reviewers only** — 2-minute urls via `review:media`, every access in `media_access_log`. Never returned to any device, not even the applicant's.
- **Active use:** until a decision.
- **After account deletion:** objects deleted at anonymization.
- **Safety/legal retention:** possibly (identity fraud investigations, hold).
- **Anonymization possible:** deletion.
- **Duration:** after the application leaves review: `RETENTION_VERIFICATION_MEDIA_DAYS` (**undecided**; shortest practical exposure is the intent).

### Reviewer notes and actions (`application_reviews`)
- **Purpose:** the review decision trail: reviewer id, action, structured reason code, request types. **There are no free-text reviewer notes in the system.**
- **Visibility:** the membership team only; applicants see status, never reasons (DEC-045).
- **After account deletion:** kept (no personal data; points at the application id).
- **Safety/legal retention:** yes, as part of the decision trail — duration **undecided**.
- **Anonymization possible:** already identity-free beyond the reviewer's own id.

### Audit events (`audit_events`), media access log (`media_access_log`) and application access log (`application_access_log`)
- **Purpose:** what changed, when, by whom (applicant, member, reviewer, system/operator); who opened private media and why; who opened an application's review view (DEC-087: key id + reviewer id, ids only).
- **Visibility:** the team only.
- **After account deletion:** kept (opaque ids, structured metadata, no free text).
- **Safety/legal retention:** audit retention by definition.
- **Anonymization possible:** they hold no identity beyond ids.
- **Duration:** `RETENTION_AUDIT_DAYS` (**undecided**); never deleted for an account under hold — audit events by account, access logs through the application (and media) they concern.

### Public member profile (`member_profiles`, `member_media`)
- **Purpose:** what other members see.
- **Visibility:** members allowed by the introduction/match rules; never across a block.
- **Active use:** while the membership is live.
- **After account deletion:** hidden at the request; anonymized to "Former member" with every field cleared; photos deleted.
- **Safety/legal retention:** reported profile content may need a hold.
- **Anonymization possible:** yes — implemented.
- **Duration:** removed photos: `RETENTION_REMOVED_PROFILE_MEDIA_DAYS` (**undecided**); never purged while the member is under hold or has an open report against them.

### Dating settings (`dating_settings`)
- **Purpose:** private matching data (identity, categories, seeking, age range).
- **Visibility:** the member themselves; the server's eligibility function. Never anyone else.
- **After account deletion:** deleted at anonymization.
- **Safety/legal retention:** no.
- **Anonymization possible:** deletion.

### Introduction history (`introduction_batches`, `introduction_entries`)
- **Purpose:** daily batches; prevents repeats; pair history.
- **Visibility:** the viewer's own batch.
- **After account deletion:** kept (opaque ids) — no new ones.
- **Safety/legal retention:** no particular need; kept for consistency.
- **Anonymization possible:** yes (ids only).
- **Duration:** **undecided** (a compaction window could remove old batches without product impact).

### Reactions (`reactions`)
- **Purpose:** pass/like per introduction; mutual likes create matches.
- **Visibility:** never shown to the other person except as a resulting match.
- **After account deletion:** kept (opaque ids).
- **Safety/legal retention:** no particular need.
- **Anonymization possible:** yes (ids only).
- **Duration:** **undecided**.

### Matches (`matches`)
- **Purpose:** the pair's relationship state: ACTIVE, ENDED, BLOCKED, with history (DEC-060).
- **Visibility:** the two members while ACTIVE.
- **After account deletion:** ACTIVE matches end at the request (`ACCOUNT_DELETED`); rows kept.
- **Safety/legal retention:** yes, as context for conversations and reports.
- **Anonymization possible:** yes (ids only).
- **Duration:** **undecided**.

### Messages (`messages`, `conversations`, `conversation_participants`)
- **Purpose:** text between matched members.
- **Visibility:** the two participants while the match is ACTIVE; the team on report.
- **After account deletion:** the conversation closes at the request; the other member no longer sees it. Messages are retained as possible safety evidence.
- **Safety/legal retention:** **yes** — harassment reports often concern messages.
- **Anonymization possible:** the sender is an opaque id after anonymization; the text itself is content and is not rewritten.
- **Duration:** messages of closed conversations: `RETENTION_SAFETY_RECORDS_DAYS` (**undecided**); never purged when either participant is under hold.

### Blocks (`blocks`)
- **Purpose:** silent, total separation between two members.
- **Visibility:** the blocker (their list); never the blocked member.
- **After account deletion:** kept (opaque ids); the blocker's list shows "Former member".
- **Safety/legal retention:** **yes** — a block protects someone.
- **Anonymization possible:** yes (ids only).
- **Duration:** **undecided**; blocks are not purged by any current window.

### Reports (`reports`)
- **Purpose:** structured reports for the membership team.
- **Visibility:** the team only; the reported member is never told.
- **After account deletion:** kept (opaque ids).
- **Safety/legal retention:** **yes**.
- **Anonymization possible:** yes (ids + structured reason; no free text).
- **Duration:** closed reports: `RETENTION_SAFETY_RECORDS_DAYS` (**undecided**); never while either side is under hold.

### Billing references (`memberships`, `billing_events`, `membership_plans`)
- **Purpose:** membership state and the provider's confirmations (event id, kind, provider name). No card or bank data is ever stored here.
- **Visibility:** the member (own membership); the team.
- **After account deletion:** membership cancelled at the request; rows kept.
- **Safety/legal retention:** **likely** (financial record-keeping) — **undecided** until a billing provider and its obligations exist.
- **Anonymization possible:** yes (ids only).
- **Duration:** **undecided**.

### Operational artifacts
| Data | Purpose | Lifetime (implemented) |
|---|---|---|
| `media_uploads` (pending) and `incoming/` objects | direct uploads not yet completed | expire after 10 minutes; once an upload's url is dead, its incoming key is deleted one final time whatever the outcome (`incoming_swept_at`); an `incoming/` bucket lifecycle rule (≈1 day) is required as a second line |
| `media_uploads` (completed/rejected/expired rows) | upload history | kept (no image data); duration **undecided** |
| `internal_nonces` | replay protection for internal calls | deleted 10 minutes after use |
| `rate_limit_events` | sliding windows | deleted after 2 days |
| `retention_holds` | open investigations / legal requests | kept (audit of holds) |

## 4. Configuration

| Variable | Class | Default |
|---|---|---|
| `ACCOUNT_DELETION_GRACE_HOURS` | delay before anonymization | 0 (undecided) |
| `RETENTION_REMOVED_PROFILE_MEDIA_DAYS` | removed member photos | unset → kept |
| `RETENTION_RETIRED_APPLICATION_MEDIA_DAYS` | replaced application photos | unset → kept |
| `RETENTION_VERIFICATION_MEDIA_DAYS` | identity photos after a decision | unset → kept |
| `RETENTION_AUTH_RECORDS_DAYS` | OTP challenges, revoked/expired sessions | unset → kept |
| `RETENTION_SAFETY_RECORDS_DAYS` | messages of closed conversations, closed reports | unset → kept |
| `RETENTION_AUDIT_DAYS` | audit events, media access log | unset → kept |

The retention process runs through `POST /internal/retention/run`
(`retention:run` scope) on a schedule chosen by operations (not yet
scheduled anywhere). Every step is idempotent; holds are always respected.
Tests: server/test/account.test.ts, server/test/media.test.ts.

## 5. Open policy questions

- Every duration marked **undecided** above.
- Whether deletion offers an undo window (grace period).
- Whether NOT_ADMITTED applications are kept to inform re-application, and for how long.
- What the billing provider's record-keeping obligations will require.
- Who may place and release holds, and the review process for them.

## Dry run (DEC-075)

`POST /internal/retention/run { "dryRun": true }`, or
`node dist/ops.mjs retention --dry-run`, changes nothing. It answers the
same report as a real run, plus:
- `dryRun: true`;
- `windows`: every configured window in days, `null` = off.

That shows "no policy configured" explicitly. Counts are taken step by step
against the current state, so a row an earlier step would remove (an
anonymized account's sessions) may also be counted by a later window: dry-run
counts are an **upper bound**. Holds are honoured in the dry run exactly as
in a real run.

Rehearsed on QA data only (docs/STAGING.md §6): dry run, then a real run,
then a repeat run with nothing left to do. No retention window is configured
anywhere: the periods are policy decisions that have not been made.
