# DATA MODEL — PRODUCT-LEVEL SCHEMA

This is a conceptual source of truth, not a forced database implementation.

Use it to preserve separation between:
- account
- application
- private data
- member profile
- membership

---

# 1. UserAccount

```ts
type UserAccount = {
  id: string
  phoneE164: string
  phoneVerifiedAt: string | null
  createdAt: string
  updatedAt: string
  accountStatus: 'active' | 'suspended' | 'deleted'
}
```

Phone number is private.

Server lifecycle (DEC-066, `accounts.account_status`): `active ⇄ suspended`,
`active → deletion_requested → anonymized`. An anonymized account keeps its
id (other records point to it); its phone number and verification time are
cleared (the number may sign up again as a new person). Columns
`suspended_at`, `deletion_requested_at`, `anonymized_at`; constraints tie
each status to its timestamp and `anonymized ⇔ phone_e164 IS NULL`. The
app's `UserAccount` only ever describes the signed-in person's own active
account (`deleted` covers both server deletion states).

Sessions (`sessions`): `token_hash` (SHA-256; the token itself is never
stored), `family_id` (rotation lineage), `created_at`, `expires_at`
(absolute), `last_used_at` (idle expiry), `revoked_at` + `revoked_reason`
(SIGN_OUT · SIGN_OUT_ALL · ROTATED · REUSE_DETECTED · SUSPENDED ·
DELETION_REQUESTED · EXPIRED), `replaced_by`.

---

# 2. ApplicationStatus

```ts
type ApplicationStatus =
  | 'UNAUTHENTICATED'
  | 'PHONE_VERIFICATION'
  | 'APPLICATION_DRAFT'
  | 'APPLICATION_SUBMITTED'
  | 'APPLICATION_RECEIVED'
  | 'UNDER_REVIEW'
  | 'EXTENDED_APPLICATION_REQUIRED'
  | 'EXTENDED_APPLICATION_DRAFT'
  | 'EXTENDED_APPLICATION_SUBMITTED'
  | 'FINAL_REVIEW'
  | 'MORE_INFORMATION_REQUIRED'
  | 'WAITLISTED'
  | 'APPROVED'
  | 'NOT_ADMITTED'
  | 'MEMBERSHIP_PAYMENT_REQUIRED'
  | 'ACTIVE_MEMBER'
  | 'SUSPENDED'
  | 'EXPIRED'
```

This is authoritative.

---

# 3. MembershipApplication

```ts
type MembershipApplication = {
  id: string
  userId: string
  status: ApplicationStatus

  stage1CompletedAt: string | null
  submittedAt: string | null
  reviewStartedAt: string | null
  extendedRequestedAt: string | null
  extendedSubmittedAt: string | null
  finalReviewStartedAt: string | null
  decisionAt: string | null            // latest approve / waitlist / not-admit

  moreInformationRequestedAt: string | null
  moreInformationReturnTo: 'UNDER_REVIEW' | 'FINAL_REVIEW' | null
  informationProvidedAt: string | null // applicant last sent a requested update
  reopenedAt: string | null            // waitlisted application reopened

  createdAt: string
  updatedAt: string
}
```

Decision reasons are NOT on this record (it is returned to the applicant) —
see §7 ApplicationReviewRecord.

---

# 4. PrivateApplicationData

```ts
type PrivateApplicationData = {
  applicationId: string

  firstName: string
  lastName: string
  dateOfBirth: string

  instagramHandle: string | null

  countryCode: string
  cityId: string | null
  cityLabel: string

  referralIds: string[]

  occupation: string | null
  workContext: string | null           // display form
  workContextAnswer: WorkContextAnswer | null  // structured, for clarification requests
  workDescription: string | null
  personalResponse: string | null

  interests: string[]
  intents: string[]

  education: string | null
  websiteUrl: string | null
  portfolioUrl: string | null

  createdAt: string
  updatedAt: string
}
```

Do not directly expose this object to member clients.

---

# 5. ApplicationMedia

```ts
type ApplicationMedia = {
  id: string
  applicationId: string
  type: 'photo' | 'video'
  purpose: 'profile' | 'verification'  // verification photos never join a profile
  storageKey: string
  order: number                        // -1 = not (or no longer) on the profile
  moderationStatus:
    | 'pending'
    | 'approved'
    | 'rejected'
  requestId: string | null             // uploaded to answer an information request
  retiredAt: string | null             // replaced via a request; kept for audit
  createdAt: string
}
```

Photos uploaded but removed before Stage 2 submission are taken off the
profile (order -1) at submission.

Media classes (DEC-063): `purpose: 'profile'` is APPLICATION_MEDIA (bucket
`media`), `purpose: 'verification'` is VERIFICATION_MEDIA (a separate
`verification` bucket). For verification media `storageKey` is always the
empty string in every response — it is never delivered to a device.
`purged_at` (server) marks objects deleted under the retention policy; the
row stays. Uploads in progress live in `media_uploads` (class, declared
type and size, incoming key, PENDING → COMPLETED | REJECTED | EXPIRED,
10-minute expiry); reviewer access to application media is recorded in the
append-only `media_access_log` (principal, purpose, time).

---

# 5b. DatingPreferencesRecord — private matching data

```ts
type DatingPreferencesRecord = {
  applicationId: string
  userId: string
  meet: string[]              // catalogue ids: 'women' | 'men' | 'everyone' (exclusive) — extensible
  ageRange: { min: number; max: number }  // whole years, 18–80, span ≥ 1
  createdAt: string
  updatedAt: string
}
```

Exists only when the applicant chose Dating (DEC-040). Stored apart from
PrivateApplicationData and from every profile. Readable only by the person
and authorised matching/review systems. Never on the profile preview, the
review portrait, referral surfaces or member profiles; never returned to the
device after submission.

---

# 5c. InformationRequest (MORE_INFORMATION_REQUIRED)

```ts
type InformationRequestType =
  | 'REPLACE_PHOTO'
  | 'VERIFY_IDENTITY'
  | 'UPDATE_INSTAGRAM'
  | 'CLARIFY_WORK'
  | 'UPDATE_APPLICATION_FIELD'   // 'whatYouDo' | 'aboutYou'

type InformationRequest = {
  id: string
  applicationId: string
  type: InformationRequestType
  explanation: string            // applicant-facing, from a curated preset — never free text
  target:
    | { kind: 'photo'; mediaId: string }
    | { kind: 'field'; field: 'whatYouDo' | 'aboutYou' }
    | null
  status: 'open' | 'answered' | 'resolved' | 'withdrawn'
  response: InformationResponse | null   // touches only this request's target
  createdAt: string
  answeredAt: string | null
  resolvedAt: string | null
}
```

The applicant receives a projection (`ApplicantInformationRequest`): the
request plus their OWN current answer for its target. No reviewer data. An
answered VERIFY_IDENTITY request is projected as `{ kind:
'verification_received' }` — the identity photo itself is never returned,
not even to its owner (DEC-063). At anonymization, `response` is cleared.

---

# 6. Referral

```ts
type Referral = {
  id: string
  applicationId: string
  applicantUserId: string
  referrerMemberId: string
  status:
    | 'requested'
    | 'confirmed'
    | 'declined'
    | 'expired'
  requestedAt: string
  respondedAt: string | null
}
```

Referral is private.

---

# 7. ApplicationReview / ApplicationReviewRecord

Internal/admin only. Implemented (Phase 4) as one record per reviewer action:

```ts
type InternalDecisionReason =
  | 'COMMUNITY_FIT' | 'TRUST_REVIEW' | 'APPLICATION_QUALITY'
  | 'CAPACITY' | 'SAFETY' | 'OTHER'

type ApplicationReviewRecord = {
  id: string
  applicationId: string
  reviewerId: string
  action: 'START_REVIEW' | 'REQUEST_EXTENDED' | 'REQUEST_INFORMATION'
        | 'WAITLIST' | 'APPROVE' | 'NOT_ADMIT' | 'REOPEN'
  fromStatus: ApplicationStatus
  toStatus: ApplicationStatus
  reasonCode: InternalDecisionReason | null   // never shown to applicants; never a score
  requestTypes: InformationRequestType[]
  createdAt: string
}
```

Earlier conceptual shape, kept for multi-reviewer recommendations later:

```ts
type ApplicationReview = {
  id: string
  applicationId: string
  reviewerId: string

  reviewStage:
    | 'initial'
    | 'extended'
    | 'final'

  recommendation:
    | 'continue'
    | 'waitlist'
    | 'approve'
    | 'not_admit'
    | 'more_information'

  notes: string | null

  createdAt: string
  updatedAt: string
}
```

Do not expose reviewer identity or notes to applicants.

---

# 8. PublicMemberProfile

Created only for activated members — once, by the server, at activation
(DEC-049), through the sanctioned whitelist constructor
`createPublicProfile` (src/domain/profile/publicProfile.ts).

```ts
type PublicMemberProfile = {
  id: string            // the member's identifier towards other members
  userId: string        // never sent to other members
  displayName: string   // first name (display-name policy pending)
  age: number           // derived from the private DOB at read time
  occupation: string | null
  cityLabel: string | null
  bio: string | null    // unused in V1
  knownFor: string | null   // from the application's work description; member-editable
  interests: string[]
  intents: ('dating' | 'friendship' | 'community')[]
  visibility: 'visible' | 'paused' | 'hidden'
  confirmedAt: string | null  // profile confirmation after activation
  createdAt: string
  updatedAt: string
}
```

Important:
Age is derived from DOB. Do not duplicate full DOB into the public profile.

Other members never receive this record. They receive a projection
(`MemberProfileView`, src/domain/member/views.ts) with exactly these keys:
memberId, displayName, age, occupation, cityLabel, knownFor, interests,
intents, photos. No account id, surname, DOB, phone, Instagram, referral,
application answers, reviewer data, dating preferences or coordinates.

Editing (Edit profile) changes only: occupation, cityLabel, knownFor,
interests and photo order (plus added photos). The application record is
never changed by member edits.

---

# 9. MemberProfileMedia

```ts
type MemberProfileMedia = {
  id: string
  memberProfileId: string
  type: 'photo' | 'video'
  storageKey: string
  order: number                 // -1 = removed from the profile
  width: number | null
  height: number | null
  sourceApplicationMediaId: string | null  // promoted from this application photo
  createdAt: string
}
```

At activation, current application profile photos (not retired, not
rejected, not purged) are promoted explicitly — copied to member keys.
Verification photos never are. Server columns `removed_at` (taken off the
profile by the member — no longer delivered; requires order -1) and
`purged_at` (object deleted by the retention process; a purged photo can
never return to the profile).

---

# 9b. Member product records (first vertical slice)

All separate from the application domain (src/domain/member/*).

```ts
type DatingSettings = {         // private matching data (DEC-058) — one per member using Dating
  memberId: string
  gender: 'WOMAN' | 'MAN' | 'NON_BINARY' | 'SELF_DESCRIBED' | null   // stated after activation; never inferred
  selfDescription: string | null  // SELF_DESCRIBED only, ≤ 40 chars, never classified
  appearsAs: ('WOMAN' | 'MAN' | 'NON_BINARY')[]   // derived for fixed answers, chosen when self-described
  seeking: ('WOMAN' | 'MAN' | 'NON_BINARY')[]     // "Everyone" = all three
  ageRange: { min: number; max: number } | null
  setupCompletedAt: string | null
}

type IntroductionBatch = {     // today's introductions — finite, fixed once created
  id: string
  memberId: string
  date: string                 // calendar day (product time zone on the server)
  profileIds: string[]         // curated order
  createdAt: string
}

type IntroductionEntry = {     // one introduction — the unit a reaction answers
  id: string
  batchId: string
  date: string
  viewerId: string
  candidateId: string
  position: number
  context: 'DATING'
  status: 'PENDING' | 'PASSED' | 'LIKED' | 'WITHDRAWN'   // WITHDRAWN: no longer eligible (block, membership, preferences)
  respondedAt: string | null
  createdAt: string
}

type MemberReaction = {
  id: string
  fromMemberId: string
  toMemberId: string
  type: 'PASS' | 'LIKE'
  introductionId: string | null  // unique: one answer per introduction
  batchId: string | null
  createdAt: string
}

type MatchStatus = 'ACTIVE' | 'ENDED' | 'BLOCKED'
type MatchEndReason = 'BLOCK' | 'UNMATCH' | 'MEMBERSHIP_ENDED' | 'ACCOUNT_DELETED'

type Match = {                 // exists only after two LIKEs (DEC-060, revised)
  id: string
  memberIds: [string, string]  // sorted
  pairKey: string              // at most ONE ACTIVE match per pairKey; history allowed
  status: MatchStatus          // BLOCKED ⇔ ended by a block; ACTIVE ⇔ not ended
  createdAt: string
  endedAt: string | null
  endReason: MatchEndReason | null   // internal; never shown to the other member
}

type Conversation = {
  id: string
  matchId: string
  memberIds: [string, string]
  createdAt: string
  closedAt: string | null
  openedAt: Record<string, string | null>  // own unread mark only; never shown to the other member
}

type Message = {
  id: string
  conversationId: string
  senderId: string
  body: string                 // text only, 1–2000 characters
  clientMessageId: string      // idempotency
  createdAt: string
}

type Block = { id: string; blockerId: string; blockedId: string; createdAt: string }

type Report = {
  id: string
  reporterId: string
  reportedId: string
  reason: 'NOT_GENUINE' | 'INAPPROPRIATE_PHOTOS' | 'HARASSMENT' | 'SAFETY_CONCERN' | 'UNDER_18' | 'OTHER'
  context: 'profile' | 'conversation'
  conversationId: string | null
  status: 'open' | 'reviewed'
  createdAt: string
}
```

Dating preferences (5b) seed the member's Dating settings at activation;
Dating settings are read by the single eligibility function on the server
only (src/domain/member/compatibility.ts) and never appear in any other
member's response (DEC-058).

## 9c. Relational schema (production API, `server/migrations`)

One table per concept — never one wide users table. Schema `app`; the API
is the only client (RLS on, PUBLIC revoked — DEC-064).

| Area | Tables |
|---|---|
| Identity | `accounts` (lifecycle states), `otp_challenges`, `sessions` (families, idle/absolute expiry, revocation reasons), `idempotency_keys`, `rate_limit_events`, `sms_test_outbox` (staging/test only) |
| Internal | `internal_nonces` (signed-request replay protection), `retention_holds` |
| Admission | `membership_applications`, `application_private_data`, `application_referrals`, `application_dating_preferences`, `application_media` (+ `purged_at`), `information_requests`, `application_reviews`, `audit_events` (append-only) |
| Media | `media_uploads` (direct uploads), `media_access_log` (append-only reviewer access to media), `application_access_log` (append-only: who opened an application's review view — DEC-087) |
| Membership | `membership_plans`, `memberships` (+ `activation` billing / complimentary, `granted_by` — DEC-088), `billing_events` |
| Member | `member_profiles` (+ `deleted_at`: anonymized placeholder), `member_media` (+ `removed_at`, `purged_at`), `dating_settings` |
| Introductions | `introduction_batches` (unique member+day), `introduction_entries` (composite FK to its batch's member and day), `reactions` (unique per introduction; composite FK to the introduction's viewer and candidate) |
| Matches & messages | `matches` (`status`; partial unique index: one ACTIVE per `pair_key`; history kept), `conversations` (unique per match), `conversation_participants`, `messages` (unique per sender + client message id; sender must be a participant — composite FK) |
| Safety | `blocks` (unique pair direction), `reports` — protected from ordinary deletion; deletable only by the retention process under policy (DEC-067) |

Private (never in any member response): `accounts.phone_e164`, everything
in `application_*`, `information_requests`, `application_reviews`,
`audit_events`, `dating_settings`, `billing_events`, reasons and safety
records. Age is computed in SQL from `application_private_data.date_of_birth`
for public reads. DDL: `server/migrations/0001–0012`; concurrency and
indexes: docs/BACKEND_ARCHITECTURE.md; retention of every table:
docs/DATA_RETENTION.md.

---

# 10. Membership

```ts
type Membership = {
  id: string
  userId: string
  planId: string
  status:
    | 'pending'
    | 'active'
    | 'grace_period'
    | 'cancelled'
    | 'expired'

  startedAt: string | null
  renewsAt: string | null
  endsAt: string | null
  activation: 'billing' | 'complimentary' // complimentary: an invited membership (staging, DEC-088)

  createdAt: string
  updatedAt: string
}
```

The server also records `granted_by` (the reviewer who started an invited
membership); it is internal and never sent to the member.

---

# 10b. MembershipPlan

```ts
type MembershipPlan = {
  id: string
  name: string                  // 'Membership' — no tiers
  billingPeriod: 'monthly' | 'annual'
  priceMinor: number
  currency: string              // ISO 4217
  isDevelopmentFixture: boolean // true until pricing is decided (DEC-047)
}
```

Membership becomes `active` only when the server records a payment
confirmation from the billing provider — or, on staging only, when the
membership team starts an invited (complimentary) membership, which records
no payment at all (DEC-088). Never from the client.

---

# 11. City

```ts
type City = {
  id: string
  countryCode: string
  name: string
  normalizedName: string
  isActive: boolean
}
```

Do not hard-code only Turkish cities.

---

# 12. Interest

```ts
type Interest = {
  id: string
  label: string
  category: string | null
  isActive: boolean
  order: number
}
```

---

# 13. Audit Event

For sensitive lifecycle changes.

```ts
type AuditEvent = {
  id: string
  applicationId: string | null
  userId: string | null
  eventType: AuditEventType
  previousStatus: ApplicationStatus | null
  newStatus: ApplicationStatus | null
  actorType: 'applicant' | 'reviewer' | 'system'
  actorId: string | null          // internal only
  reasonCode: InternalDecisionReason | null  // internal only
  metadata: Record<string, string | number | boolean | null | string[]>  // structured, no free text
  createdAt: string
}
```

Event types (implemented):
- PHONE_VERIFIED
- APPLICATION_SUBMITTED
- APPLICATION_REVIEW_STARTED
- EXTENDED_APPLICATION_REQUESTED
- EXTENDED_APPLICATION_STARTED
- EXTENDED_APPLICATION_SUBMITTED
- FINAL_REVIEW_STARTED
- MORE_INFORMATION_REQUESTED
- MORE_INFORMATION_PROVIDED
- APPLICATION_WAITLISTED
- APPLICATION_APPROVED
- APPLICATION_NOT_ADMITTED
- APPLICATION_REOPENED
- MEMBERSHIP_ACTIVATION_STARTED
- MEMBERSHIP_ACTIVATED

Audit records are never sent to applicant clients.

---

# 14. Core Separation Rule

Never collapse:

UserAccount
+
MembershipApplication
+
PrivateApplicationData
+
PublicMemberProfile
+
Membership
+
DatingPreferences
+
Introduction / Reaction / Match
+
Conversation / Message
+
Block / Report

into one giant "User" object.

They have different privacy and lifecycle responsibilities.

---

# 15. Derived Values

Derive where possible:

age
from:
dateOfBirth

member access
from:
application status + membership status

profile visibility
from:
member profile visibility

Do not store redundant booleans unless justified.

---

# 16. Authorization Principle

Backend authorization must enforce:

Applicants:
- can read own application status
- can edit permitted draft fields
- cannot query members

Active members:
- can access member-only APIs according to privacy rules (the MemberApi
  requires ACTIVE_MEMBER with a live membership on every call)
- can see only members introduced to them today or matched with them
- can react only to today's introductions; matches are created by the server
- can open conversations and send messages only within an active match
- "unavailable" (unknown, blocked, not introduced) is one uniform refusal

Admin/reviewer:
- only according to role and audit policy
- review states change only through reviewer actions (DEC-041); the
  applicant API has no endpoint that changes a review state
