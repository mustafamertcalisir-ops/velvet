# PRODUCT DECISIONS

This file records stable product decisions.

Do not reverse these silently.

---

## DEC-001 — Phone verification comes first

Status:
Accepted

Decision:
The first functional step is phone-number verification.

Reason:
Creates a persistent account identity before application data is collected.

---

## DEC-002 — Applicants are not members

Status:
Accepted

Decision:
An applicant cannot access member-only areas before approval and membership activation.

---

## DEC-003 — Stage 1 is intentionally short

Status:
Accepted

Decision:
The first application collects only core identity/context signals.

Stage 1:
- first name
- last name
- DOB
- Instagram
- country
- city
- referral

---

## DEC-004 — DOB, not age input

Status:
Accepted

Decision:
Ask for date of birth and derive age.

Reason:
Avoid stale age data and support 18+ validation.

---

## DEC-005 — Last name is private by default

Status:
Accepted

Decision:
Last name is application information and does not automatically appear publicly.

---

## DEC-006 — Referral is optional

Status:
Accepted

Decision:
Applicants can apply without an existing-member referral.

Reason:
A strong applicant should not be excluded solely for lacking an existing social connection.

---

## DEC-007 — Referral does not guarantee approval

Status:
Accepted

Decision:
Referral is one trust/familiarity signal only.

---

## DEC-008 — No instant approval

Status:
Accepted

Decision:
Submitting Stage 1 never immediately creates membership.

---

## DEC-009 — Application Received is a real waiting state

Status:
Accepted

Decision:
After submission the applicant enters APPLICATION_RECEIVED and waits for review progression.

---

## DEC-010 — Under Review is a separate state

Status:
Accepted

Decision:
APPLICATION_RECEIVED and UNDER_REVIEW are distinct.

---

## DEC-011 — Photos are not requested in Stage 1

Status:
Accepted

Decision:
Profile photos are requested later, after the application progresses to the extended stage.

---

## DEC-012 — Extended application is conditional

Status:
Accepted

Decision:
The user completes Stage 2 only after EXTENDED_APPLICATION_REQUIRED.

---

## DEC-013 — Stage 2 does not guarantee approval

Status:
Accepted

Decision:
Completing photos and profile information leads to FINAL_REVIEW, not automatic acceptance.

---

## DEC-014 — Public profile data is separate

Status:
Accepted

Decision:
Private application data and public member profile data are separate domain models.

---

## DEC-015 — High-end does not mean visible wealth

Status:
Accepted

Decision:
The product will not use conspicuous wealth as its core visual or admission signal.

---

## DEC-016 — No gold/VIP cliché system

Status:
Accepted

Decision:
Avoid:
- gold gradients
- crowns
- diamonds
- VIP badges
- "elite" terminology
- marble luxury clichés

---

## DEC-017 — Raya is reference, not template

Status:
Accepted

Decision:
Raya may be studied for principles such as restraint, curation, profile hierarchy, and privacy.

The product must remain visually and functionally original.

---

## DEC-018 — Exact location is private

Status:
Accepted

Decision:
Future location features should use city/neighborhood/approximate presence by default.

---

## DEC-019 — Application lifecycle uses explicit states

Status:
Accepted

Decision:
Do not model core admission behavior as scattered booleans.

---

## DEC-020 — Türkiye-first, not Türkiye-only

Status:
Accepted

Decision:
Initial focus is Türkiye, but international phone numbers, locations, and future expansion must remain supported.

---

# Decisions made during implementation

Phase 1 (3 Oct 2026) and the Phase 1 alignment + Stage 2 pass (same day).
Items marked **Proposed** still need product-owner confirmation.

---

## DEC-021 — Stack: Expo + React Native + TypeScript + Expo Router

Status:
Accepted

Decision:
Expo SDK 57, React Native 0.86, TypeScript (strict), Expo Router file-based
routing under `src/app/`. Routes render from the lifecycle via guards
(`src/navigation/Guard.tsx`); there are no hard-coded cross-zone jumps.

---

## DEC-022 — Referral privacy (revised)

Status:
Accepted (revised in the alignment pass; replaces the Phase 1 wording)

Decision:
- A referral may be requested using identifying information (the referrer's
  name and mobile number) because the membership team needs to reach them.
- The product never reveals whether a number belongs to a member. Every
  request gets the same generic response: "Referral requested".
- After a referral is added it is shown only as a short name — "Kerem A." —
  never with the phone number (not even masked), never with membership
  state, never as a count presented as status.
- Applicants cannot search or browse members.
- Referral remains optional. Self-referral and duplicates are rejected.
- After the server acknowledges the application, referral details are
  removed from the device (see DEC-031).

---

## DEC-023 — Instagram is required in V1 (replaces the Phase 1 opt-out)

Status:
Accepted

Decision:
Instagram is a required Stage 1 field in V1. The "I don't use Instagram"
option is removed from the default flow. Instagram is an application/review
signal only — it is not a public member-profile field.

Future versions may add an alternate route (professional website, portfolio,
LinkedIn or another verified presence). That path is not built. Drafts saved
by older builds with the retired opt-out are sent back to the Instagram step.

---

## DEC-024 — Submissions are idempotent and survive restart

Status:
Accepted

Decision:
Stage 1: DRAFT → SUBMITTED (client, with a persisted idempotency key) →
RECEIVED only on server acknowledgement. Stage 2 mirrors it:
EXTENDED_DRAFT → EXTENDED_SUBMITTED → FINAL_REVIEW, set by the server.
Network failures stay in the *_SUBMITTED state and retry with the same key;
content rejected by the server reopens the draft. One application per account.

---

## DEC-025 — (withdrawn)

The 29 February rule is not a product decision. Age uses standard calendar
arithmetic (`ageOn` in `src/domain/validation/dateOfBirth.ts`) and is covered
by tests, including leap-day birthdays. The product rule is only DEC-004:
applicants must meet the minimum age (18).

---

## DEC-026 — Date of birth is entered as Day / Month / Year

Status:
Accepted

---

## DEC-027 — Status sequence and the status home

Status:
Accepted

Decision:
The status sequence is "Received · Review · Decision", or four stages once the
extended stage begins (adding "Final review"). No dates per stage, estimates,
positions or percentages. The status screen always states: current state,
submission date, the applicant's next step ("Nothing for now" when there is
none), and that updates appear there. A primary action appears only when the
applicant actually has one.

---

## DEC-028 — Brand name is not finalised

Status:
Accepted

Decision:
"Velvet" is a placeholder. It appears only as the wordmark, from one constant
(`src/config.ts`). It is not used in copy, identifiers, assets or
architecture. Typefaces and photography are also provisional; photography is
placeholder Unsplash imagery with a project grade (`scripts/grade-photography.py`).

---

## DEC-029 — Sign-out removes private application data from the device

Status:
Accepted

---

## DEC-030 — Development tooling is behind explicit flags and never ships

Status:
Accepted

Decision:
- Dev hooks (no UI, used by automated tests): on in dev builds or with
  `EXPO_PUBLIC_ADMISSION_DEV_HOOKS=1`.
- Dev panel (visible OTP hint, reviewer simulation): only with
  `EXPO_PUBLIC_ADMISSION_DEV_PANEL=1`, even in dev builds, so it never appears
  in normal screenshots.
- `EXPO_PUBLIC_APP_ENV=production` forces both off (set in `eas.json`).
- Builds run with `--clear`: Metro can otherwise reuse cached transforms with
  previously inlined env values (found during this pass). `npm run check:release`
  fails if a production bundle could expose dev tooling.

---

## DEC-031 — The device keeps only what the applicant's own screens show

Status:
Accepted

Decision:
After the server acknowledges Stage 1, the device keeps first name, last
name, country and city (for the applicant's own status summary) and drops
date of birth, Instagram and referral details. After Stage 2 is acknowledged,
the extended answers and photo references are dropped from the device.
Age and city for display come from the server (`ApplicantSummary`), so the
device never needs the full date of birth again. Photos are re-encoded before
upload, which strips EXIF metadata such as GPS location.

---

## DEC-032 — Typography roles

Status:
Accepted (families provisional)

Decision:
Serif (Newsreader) is the editorial voice: screen questions and major titles,
the Received and Final-review moments, the status headline, and the Stage 1
read-back. Everything operated or scanned — typed answers, labels, helper
copy, validation, search, lists, metadata, status details, buttons, progress —
uses the UI sans (Instrument Sans).

---

## DEC-033 — Stage 2 scope in this pass

Status:
Accepted (limits provisional)

Decision:
Built: intro, photos (3–6, ADMISSION_FLOW target), occupation, work context
(optional, answered explicitly), what you're known for, about you, curated
interests (3–8 from a fixed list with no wealth signals), intent (Dating /
Friendship / Community, multi-select), profile preview, extended review,
submission → FINAL_REVIEW. Not yet built: dating preferences (EXT-08),
education (EXT-09), portfolio/website (EXT-10), additional verification
(EXT-11). The profile preview shows only first name, derived age,
occupation, city, intent, "known for" and chosen interests (see DEC-034).

---

## DEC-034 — Profile presentation: one lead frame, then one column

Status:
Accepted

Decision:
A profile (the applicant's preview now; member profiles later) is a
full-bleed lead frame — photo or, later, a short video — with identity on
its lower edge: serif first name, sans age, occupation, city, and intent as
one sentence ("Here for friendship and community"). Below it, one editorial
column alternates words and photographs: Known for → photo 2 → interests as
a typeset line → remaining photos. Scrolling is the only way through; there
is no tap-through carousel, and every photograph appears exactly once. It is
built by `buildProfilePreview`, a whitelist that cannot receive surname, date
of birth, phone, Instagram, referral or reviewer data. The media model is a
`photo | video` union, so video can be added without restructuring. Audio is
not part of profiles (pending decision).

Not copied from reference products: round action-button rows, "liked you"
labels, public handles, card frames, glass bio panels.

---

## DEC-035 — Interests are a curated collection in five rooms

Status:
Accepted (catalogue provisional)

Decision:
The 31 interests are grouped into Culture, Ideas, Music, Outdoors and
Table & travel (`INTEREST_GROUPS`, tested to cover the catalogue exactly
once). The screen shows the chosen collection as the sentence it will become
on the profile, with a tabular "n / 8"; room tabs show how many of their
interests are chosen; each room is one column of rows. 3–8 remain the
limits. At 8, the other rows step back and a note explains how to change the
selection; a ninth is never silently ignored. No tag cloud, no pills.

---

## DEC-036 — "About you" is for the membership team

Status:
Accepted

Decision:
The "What should we know about you?" answer is an application answer. It is
not part of the profile preview, and the screen says so ("For our membership
team, not your profile."). Any public use later needs its own decision and
the applicant's explicit choice.

---

## DEC-037 — QA photography never ships

Status:
Accepted

Decision:
Photo uploads in E2E use four Unsplash images in `e2e/fixtures/` (sources
listed in `e2e/fixtures/README.md`). They exist only to make Visual QA
realistic. They are never imported by app code, never bundled (verified by
hashing every image in the web and native exports), and never used as member
or marketing imagery.

---

## DEC-038 — The application status family

Status:
Accepted

Decision:
Received, Status (every state), the Stage 2 introduction and the Final
Review receipt share one composition: the application photograph (full or
as a scrolling band), a quiet kicker naming the letter ("Membership
application" or "Application update"), a serif headline, and, where there
is a sequence, the same stage line. "Continue your application" is
therefore read as the next line of the same letter, not a new form.

---

## DEC-039 — Selection is shown by typography, not colour

Status:
Accepted

Decision:
Chosen answers step forward: the title moves from Smoke to Pearl, sits on a
quiet Ink band with a short Pearl rule at its leading edge, and carries a
small drawn tick. No radio circles, no checkbox squares, no pills, and no
accent colour. This applies to Stage 2 choices, interests and the Stage 1
country and city lists. The accent is reserved for the current review stage
(Pomegranate mark) and validation.

---

## DEC-040 — Dating preferences: only with Dating, private matching data

Status:
Accepted (taxonomy and age bounds provisional)

Decision:
"Who would you like to meet?" and "What age range feels right?" are asked
only when the applicant chose Dating; otherwise both steps are skipped and no
preference is stored. Unchoosing Dating clears any saved answer. Options are a
catalogue of ids (Women, Men, Everyone; "Everyone" is exclusive), so the
taxonomy can grow without changing the stored shape. The applicant's own gender
is not asked and nothing is inferred. Age range: whole years, 18–80, at least
two ages; it starts from a neutral suggestion around the applicant's age and is
always adjustable. No distance (location belongs to the member product).
Preferences are private matching data: stored in their own server record
(`DatingPreferencesRecord`), never in `PrivateApplicationData`, never on the
profile preview, the review portrait (the review names the section and offers
Edit, without showing values), referral surfaces or any member profile, and
never returned to the device after submission.

---

## DEC-041 — Reviewer actions are the only way review states change

Status:
Accepted

Decision:
Review states change only through the reviewer endpoint, which plans each
action with shared domain rules (`src/domain/admission/review.ts`):

- APPLICATION_RECEIVED: start review
- UNDER_REVIEW: request extended application · request information · waitlist · not admit
- FINAL_REVIEW: approve · waitlist · request information · not admit
- WAITLISTED: reopen (to UNDER_REVIEW, or to FINAL_REVIEW if Stage 2 exists) · not admit

Every action is validated against the lifecycle, recorded internally, and
audited. Approval exists only from FINAL_REVIEW. The client never decides
admission; it refreshes and renders. The development reviewer fixture calls
the same endpoint, exists only in development/test builds, and is removed
from release bundles at build time; the release gate fails if any fixture code
is present.

---

## DEC-042 — More information: structured, narrow, returns to the asking stage

Status:
Accepted

Decision:
A reviewer requests one to three items from fixed types (REPLACE_PHOTO,
VERIFY_IDENTITY, UPDATE_INSTAGRAM, CLARIFY_WORK, UPDATE_APPLICATION_FIELD for
"known for" / "about you"). The applicant-facing explanation comes from
curated presets: there is no free-text question channel. Each response can
change only its own target; everything else stays locked. The applicant
saves responses (they can be changed) and then sends the update once. The
server applies the changes and returns the application to the stage that
asked (`moreInformationReturnTo`: UNDER_REVIEW or FINAL_REVIEW). A replaced
photo is retired, not deleted (kept for audit). A verification photo is never
part of a profile. A new request round withdraws unanswered requests from an
earlier round.

---

## DEC-043 — Outcome screens

Status:
Accepted

Decision:
- Waitlisted: "You're on the waitlist". Shows identity, submitted date and
  status ("On the waitlist — still active"). No stage line, no large action,
  no queue, odds, dates or pay-to-skip. Check for updates is the only action.
  The application stays active and can be reopened into review without
  reapplying.
- Not admitted: "Application update" / "We're unable to offer membership at
  this time." Calm and final: no stage line, no reasons, no scores, no
  promise about reapplying (policy pending).
- More information required: "We need a little more information." The
  requested items, with the first open item's action as the primary button,
  then "Submit update".
- A sent update shows "Your update has been sent. Review continues." and a
  "Latest update" fact only while the application is in the review stage it
  returned to, never on an outcome.

---

## DEC-044 — Audit events

Status:
Accepted

Decision:
Structured events: PHONE_VERIFIED, APPLICATION_SUBMITTED,
APPLICATION_REVIEW_STARTED, EXTENDED_APPLICATION_REQUESTED,
EXTENDED_APPLICATION_STARTED, EXTENDED_APPLICATION_SUBMITTED,
FINAL_REVIEW_STARTED, MORE_INFORMATION_REQUESTED, MORE_INFORMATION_PROVIDED,
APPLICATION_WAITLISTED, APPLICATION_APPROVED, APPLICATION_NOT_ADMITTED,
APPLICATION_REOPENED, MEMBERSHIP_ACTIVATION_STARTED, MEMBERSHIP_ACTIVATED.
Each records application id, previous and new status, actor type (applicant /
reviewer / system), internal actor id, optional internal reason code,
structured metadata (no free text) and a timestamp. Audit records, reviewer
identity and reason codes are never sent to applicant clients.

---

## DEC-045 — Internal decision reasons

Status:
Accepted (list provisional)

Decision:
Decisions may carry one internal reason code: COMMUNITY_FIT, TRUST_REVIEW,
APPLICATION_QUALITY, CAPACITY, SAFETY, OTHER. They are stored with the
internal review record and audit only, never shown to applicants, and never
combined into a numeric score of a person.

---

## DEC-046 — Approval is not membership

Status:
Accepted

Decision:
APPROVED shows "Welcome." — the photograph from the very first screen
returns full-bleed (the one change of atmosphere), one sentence, the
approval date and Continue. No celebration. Continue asks the server to open
activation (APPROVED → MEMBERSHIP_PAYMENT_REQUIRED, a pending membership
record). That state has its own route zone (`/membership`). The member
product (`/member`) opens only for ACTIVE_MEMBER with an active membership,
which only the server can set after billing confirms payment.

---

## DEC-047 — Membership activation boundary

Status:
Accepted (pricing and provider pending)

Decision:
One plan named "Membership" — no tiers or metal names. Plans come from the
server as data (`MembershipPlan`). Until pricing is decided the server returns
a plan flagged `isDevelopmentFixture`, and the screen says "Development
pricing — not final." Prices are never written into copy. The app hands over
to a `BillingProvider`. The provider confirms payment to the server, never
to the client, and the client only refreshes. Release builds have no provider
yet: activation is shown as not yet open. Development/test builds use a
fixture provider, removed from release bundles at build time.

---

## DEC-048 — The member entrance: welcome, then profile confirmation

Status:
Accepted

Decision:
Activation opens `/member`, the member entrance. Until the profile is
confirmed it shows the welcome — "You’re in." over the member's own first
photograph (the one orchestrated reveal: the photograph comes up out of
Obsidian, 320ms; none with reduced motion) — then Profile confirmation, which
shows the profile exactly as members will see it, offers Edit profile and
"Enter the community". Confirmation is recorded by the server
(`confirmedAt`), not on the device; the member tabs stay closed until it
exists. After that, `/member` opens Home. "Welcome." remains the approval
line (DEC-046); it is not repeated.

---

## DEC-049 — The member profile is made from the approved application, then owned by the member

Status:
Accepted

Decision:
At activation the server provisions one `PublicMemberProfile` through the
sanctioned whitelist constructor: first name, age (derived from the private
DOB at read time), occupation, city label, "known for" (the application's
work description), interests and intents. Current application profile
photos are promoted explicitly into `MemberProfileMedia`; verification
photos never are. Members see each other only through `MemberProfileView`
(exact keys, tested) and by member profile id — never account ids.
Edit profile changes the member profile only (occupation, city, known for,
interests, photos: order, add, remove; 3–6). The application, its decision,
referral, reviewer data and "about you" are not editable and are never
changed by member edits. Instagram is not shown publicly (DEC-023).

---

## DEC-050 — Home is today's introductions, one person at a time

Status:
Accepted (quantity and selection provisional). Selection rules CHANGED by
DEC-058: introductions are Dating introductions, chosen by the single
eligibility function. CLARIFIED 2026-10-06 (production hardening):

- Today's Introductions is **Dating-only in V1**. Members whose intents are
  only Friendship and/or Community do not take part in it — they are neither
  introduced nor introduced to anyone through it.
- Friendship and Community remain **valid, stored product intents**. They are
  not removed, not deprecated, and are never forced through Dating
  compatibility (DEC-058 applies to Dating only).
- **Friendship / Community discovery is a future product surface** with its
  own rules (MEMBER_PRODUCT_VISION.md). The broader community vision stands.
- Their Home is a quiet state that does not say the app has nothing for
  them and promises no date: "Dating introductions aren’t part of your
  experience right now." / "You joined for friendship and community. More
  community experiences will come later."

Decision:
Each member gets a finite batch per day (`IntroductionBatch`), chosen once
and never refilled. Size is server policy (`perDay`, currently 6) and is
never shown as a number. Home shows one introduction full-bleed — photo,
name and age, occupation, city, a two-line "known for" — with a quiet line
"More to come today" / "The last one today", and the dateline. Tapping
opens the profile; Pass and Like live only in the profile, after looking.
End states: "That’s everyone for today." and "No introductions today."
Selection in V1: never self, blocked (either way), matched, already liked,
passed within 30 days, hidden or incompatible members; curated order from
the server. No recommendation algorithm yet.

---

## DEC-051 — Pass, Like and matches are decided by the server

Status:
Accepted

Decision:
Two reactions only: PASS and LIKE. No super likes, boosts, roses, coins,
streaks, scores or undo. Members can react only to today's introductions.
Pass removes the introduction for the cycle (and 30 days); the profile dims
and one sentence says so. Like is a light haptic and one honest sentence
("If Deniz likes you too, you can start a conversation."). A match exists
only when both members liked each other; the server creates it — at most
one ACTIVE match per pair at a time (DEC-060). The client never infers one. The match moment is a
diptych of their photograph and yours, "You should meet.", "Send a message"
and "Keep exploring" — no confetti, hearts, neon or borrowed catchphrase.
Buttons are explicit and accessible; swipe gestures are not part of V1.

---

## DEC-052 — Compatibility in V1, and what it cannot do yet

Status:
PARTLY SUPERSEDED. For **Dating**, superseded by DEC-058 (2026-10-05): the
gender limitation described below is resolved by a private, stated Dating
identity asked after activation, and Dating introductions use reciprocal
preferences, not "shared intent".
CLARIFIED 2026-10-06: the idea of introducing members through **shared
Friendship / Community intents is NOT withdrawn** — it is deferred. It is
not part of Today's Introductions (Dating-only in V1, DEC-050) and must not
reuse Dating compatibility; it belongs to a future Friendship / Community
discovery surface with its own rules. The text below is kept as history.

Decision:
Two members can be introduced when they share an intent. When the only
shared intent is dating, each must sit within the other's private age range.
The product does not ask a member's own gender (DEC-040), so "who you’d like
to meet" (Women / Men / Everyone) cannot be honoured in matching yet. This
is a known limitation that needs a product decision (e.g. an optional,
private "I am" answer) before dating introductions are opened to real
members.

---

## DEC-053 — Conversations V1: text between matched members

Status:
Accepted

Decision:
A conversation belongs to an active match and is created when first opened.
Text only, 1–2000 characters, idempotent sends (client message id), grouped
by day ("Today", "Yesterday", "5 October") and by sender runs with a 24-hour
time. The empty conversation has one quiet line, "You met through the
community." — no generated icebreakers or suggested openers. A small
Pomegranate mark in Messages (and beside the tab) means something new; it
is the member's own state and is never shown to the other person. Not built:
typing indicators, read receipts, reactions, voice, photos, video, GIFs.

---

## DEC-054 — Block and report

Status:
Accepted (report reasons provisional)

Decision:
Every viewed profile and conversation has "More options" → Report, Block.
Report: six structured reasons, then an optional block; the reported member
is not told. Block: one confirmation that says what happens; the match ends,
the conversation closes, both members disappear from each other's
introductions, profiles and messages, and the blocked member is not told —
to them it looks like any unavailable profile. Every "unavailable" answer
from the member API is the same refusal, so blocks cannot be detected and
members cannot be enumerated. Blocked members are listed under Privacy &
safety. Unblocking is not built.

---

## DEC-055 — Member data stays off the device

Status:
Accepted

Decision:
The member client keeps introductions, other members' profiles and messages
in memory only. Nothing about other members is written to device storage;
signing out or closing the app discards it. The device continues to store
only the admission state (session, status, own summary).

---

## DEC-056 — Member navigation: Home, Messages, You

Status:
Accepted (may grow)

Decision:
Three tabs, set as words rather than icons: the current one in Pearl with a
short rule above it, the others in Smoke. The bar is Obsidian with a
hairline, never over photography. Places, Travel and Directory are later
tabs. Member photography carries the colour; the UI stays Obsidian, Ink,
Pearl and Smoke, with Pomegranate used only for the "new" mark.

---

## DEC-057 — The fixture community is development-only

Status:
Accepted

Decision:
Ten fixture members (varied work, Türkiye-first with London, Berlin and
Paris) exist only in `src/dev/communityFixture.ts`, loaded through a
build-time conditional so release bundles never contain it (the release
gate checks). Seeding uses the server's normal provisioning; the deterministic
"admirer" likes the test member through the normal reaction path, so liking
back creates a real match. Fixture photographs are QA material in
`e2e/fixtures/members/`, served by the test harness at `/__qa/` and never
bundled or used as member imagery (DEC-037).

---

## DEC-058 — Dating compatibility: a stated, private identity and reciprocal preferences

Status:
Accepted (taxonomy provisional). Changes DEC-050, supersedes DEC-052.

Decision:
Introductions are Dating introductions. A member's own Dating identity is
asked AFTER activation and only of members who chose Dating — never in the
initial application, never of friendship/community-only members:

  Activated → Welcome → Dating setup (if Dating) → Profile confirmation → Enter

1. "How do you describe yourself?" — Woman · Man · Non-binary · Self-describe.
   Self-describe takes private words (≤ 40 characters) AND the categories
   the member chooses to be included under ("Include me when people are
   looking to meet": Women / Men / Non-binary people). The words are never
   read, classified or interpreted — by people, rules or AI.
2. "Who would you like to meet?" — Women · Men · Non-binary people ·
   Everyone (= all three), plus the age range. Pre-filled from the extended
   application's answers; the member confirms or changes them.

Model: `gender` (stated answer), `appearsAs` (normalised categories —
derived for fixed answers, chosen for self-described), `seeking`
(categories), `ageRange`. Never inferred from name, photographs, Instagram,
reviewer judgement, AI or content.

One eligibility function (`datingEligibility`, src/domain/member/compatibility.ts)
decides every introduction, in order: both active members · not self ·
visible · no block either way · not exhausted from the cycle · both use
Dating and completed setup · each seeks the other's categories · each is
inside the other's age range · future safety rules (hook in place). The
server generates batches only from eligible members and re-checks waiting
introductions at read time (anyone no longer eligible is withdrawn). The
client never receives an incompatible profile, and never receives anyone's
Dating settings but its own.

Dating identity and preferences are private matching data: not on the
profile, the preview, the application summary, an introduction, the match
moment or any other member's response. Members change them in "Dating
preferences" (You); changes apply to future introductions and never delete
matches or conversations.

Members not using Dating see a quiet Home (copy revised 2026-10-06, DEC-050:
"Dating introductions aren’t part of your experience right now.") and are
introduced to no one through Dating; Friendship / Community discovery is a
future surface (DEC-050, DEC-052).

---

## DEC-059 — One production API; the mock stays for development and E2E

Status:
Accepted

Decision:
The backend is a Node.js + TypeScript API (Hono) on PostgreSQL 16, in
`server/`, with plain SQL migrations. It is the only database client and
owns admission decisions, activation, introductions, likes, matches,
conversations, blocks, reports, compatibility and audit. It implements the
same ports the app already uses (AdmissionApi, MemberApi) over a versioned
HTTP contract (`/v1`, src/services/api/contract.ts) shared by both sides,
and reuses the shared domain rules (src/domain/**) — one source of truth.

The in-app mock server stays for local development and deterministic E2E.
The build environment selects the backend: release builds
(EXPO_PUBLIC_APP_ENV=production) always use the HTTP adapters and do not
bundle the mock at all; development uses the mock unless
EXPO_PUBLIC_BACKEND=http. The release gate fails a bundle that contains the
mock server, its fixed development code, fixtures or a non-https API URL.

Hosting is not chosen: the API is a stateless Node service and the database
plain PostgreSQL (Neon, Supabase Postgres, RDS, Cloud SQL all fit). Media
live in private object storage behind the `ObjectStore` interface: any
S3-compatible service in staging/production, local disk in development
(DEC-063, revised).

---

## DEC-060 — Reactions are idempotent; at most one ACTIVE match per pair, enforced by the database

Status:
Accepted. REVISED 2026-10-06: "one match per pair, ever" is replaced by "at
most one ACTIVE match per pair at a time, with history" (see the revision
below). The reaction rules are unchanged.

Decision:
A reaction answers one introduction (`POST /introductions/{id}/reaction`).
The server validates ownership, the day and current eligibility; one
reaction per introduction (unique key). Repeating the same answer replays
the original result (double taps, retries, replays after midnight);
a different answer is refused (REACTION_ALREADY_RECORDED). Inside one
transaction the server locks the introduction row, then the PAIR (advisory
lock on the ordered pair key) before reading "did they already like me?" —
so simultaneous mutual likes are serialised and exactly one creates the
match.

Revision (2026-10-06) — match lifecycle:
- `MatchStatus = ACTIVE | ENDED | BLOCKED`. A match ends with a reason
  (`BLOCK` → BLOCKED; `UNMATCH`, `MEMBERSHIP_ENDED`, `ACCOUNT_DELETED` →
  ENDED). Ended matches are kept as auditable history; nothing is deleted.
- The database guarantees at most ONE ACTIVE match per canonical pair: a
  partial unique index `matches_one_active_per_pair ON matches (pair_key)
  WHERE status = 'ACTIVE'` (migration 0005), plus a consistency check
  (ACTIVE ⇔ not ended; BLOCKED ⇔ ended by a block). Simultaneous mutual
  likes produce exactly one ACTIVE match (pair lock + `ON CONFLICT … WHERE
  status = 'ACTIVE' DO NOTHING`); tested with real concurrent PostgreSQL
  transactions.
- Lifetime rematching is no longer impossible by construction. Whether an
  ENDED pair may ever be reintroduced is POLICY:
  `IntroductionPolicy.rematchAfterDays`, currently `null` = never. If a
  rematch policy is set, the pair starts fresh: only likes made after the
  last ended match count toward a new match.
- An active block (either direction) makes a new introduction, and so a new
  match, impossible; BLOCKED pairs are never reintroduced.
- No "unmatch" feature is built in the UI (UNMATCH exists only as a reason
  value so the architecture does not need to change later).

---

## DEC-061 — Sign-in codes: random, hashed, and never fixed outside the mock

Status:
Accepted. EXTENDED 2026-10-06: SMS provider boundary and failure handling
(below); session security moved to DEC-066.

Decision:
The API issues six-digit codes from a CSPRNG, valid 10 minutes, 5 attempts,
30-second resend cooldown, 5 codes per number per hour (plus a per-address
limit); only an HMAC of the code is stored. Sessions are random bearer
tokens stored as SHA-256 hashes, revocable at sign-out. Codes leave through
an SMS sender interface: console (development), outbox file (automated
E2E), memory (tests) — all refused at startup in staging/production. With no
provider configured, production fails closed (sign-in unavailable) rather
than fall back to anything predictable. The mock's fixed development code
exists only in the mock, which is absent from release bundles.

Extension (2026-10-06) — SMS provider boundary (docs/SMS_PROVIDER.md):
- The auth service depends only on `SmsProvider.sendVerificationCode`.
  Vendors are adapters; `routeSms` routes by country prefix (longest prefix
  wins) and refuses numbers with no route (fail closed). Netgsm is the
  adapter selected for the first staging integration (+90 only), pending a
  provider account and confirmation of its current API reference.
- Failures are classified internally — NOT_CONFIGURED, PROVIDER_UNAVAILABLE,
  RATE_LIMITED, DELIVERY_REJECTED, INVALID_PHONE — and logged with the
  class and a safe vendor status only. The client receives
  `CODE_NOT_SENT` ("We couldn’t send a code right now. Try again.") or, when
  the provider says the number is invalid, `INVALID_PHONE`. The undelivered
  challenge is consumed so it can never be used.
- Requesting a code answers identically whether or not the number has an
  account (enumeration resistance); verification attempts are also limited
  per number across challenges.
- Staging only: codes for designated TEST numbers (`SMS_TEST_NUMBERS`) go to
  an internal outbox readable once through a signed internal call with the
  `test:otp` scope. Both are refused in production by configuration.

---

## DEC-062 — Rate limits

Status:
Accepted (numbers provisional)

Decision:
Sliding windows in PostgreSQL (shared by all API instances; replaceable by
Redis behind the same interface): codes per number (5/hour) and per address
(30/hour); verifications per address (60/hour) and per number across
challenges (20/hour); reactions (200/hour); messages (30/minute,
1000/day); reports (20/day); profile updates (60/hour); upload
authorizations (40/hour); Dating settings (30/hour); account-deletion
requests (5/hour). Refusals are RATE_LIMITED with a retry hint. The client
address comes from the socket or, behind a proxy, only from the
X-Forwarded-For entry our own proxy appended (TRUST_PROXY_HOPS) — a
client-supplied entry cannot dodge per-address limits. No limit lives only
in process memory: two API instances share the same counters (tested).

---

## DEC-063 — Media: sanitised, private, signed

Status:
Accepted. REVISED 2026-10-06: direct uploads to private object storage and
three media classes replace base64 uploads through the API (revision below).

Decision:
Every upload is checked by content (JPEG, PNG, WebP), bounded in size and
pixels, and re-encoded (orientation applied, longest edge ≤ 2048 px) — which
drops EXIF, GPS and every other metadata block — before it is stored. Bytes
live in a private store under opaque keys by category: `application/`,
`verification/`, `member/`. No permanent public URLs exist: clients get
HMAC-signed URLs that expire (member photos 15 min, application 10 min,
verification 5 min), minted only for someone allowed to see the item at that
moment. Verification photos are never minted for members; promotion to a
member profile copies approved application photos to member keys. Short
video is modelled (`type: 'video'`) but not accepted yet.

Revision (2026-10-06) — docs/MEDIA_ARCHITECTURE.md:
- Direct upload: `POST /v1/media/uploads` (class, type, size, request) →
  a 10-minute signed PUT url to `incoming/` in private storage (type and
  length signed) → the client uploads the bytes directly → `POST
  /v1/media/uploads/{id}/complete` → the server re-checks authorization,
  reads the object (size-bounded), identifies it by content (and requires
  it to match the declared type), re-encodes it without metadata, stores it
  under its final key, creates the media row and deletes the incoming
  object. Image bytes never travel through the API as JSON/base64; the old
  base64 routes are removed.
- Classes with different rules: APPLICATION_MEDIA (extended draft, or an
  open REPLACE_PHOTO request), VERIFICATION_MEDIA (an open VERIFY_IDENTITY
  request only; a SEPARATE bucket; never returned to any device — the
  applicant sees "received", never the image; reviewers only, through
  `review:media`, 2-minute urls, every access in the append-only
  `media_access_log`), PROFILE_MEDIA (ACTIVE_MEMBER with a live
  membership).
- Delivery urls: profile 15 min, application 10 min, verification 2 min.
- Lifecycle: abandoned uploads expire after 10 minutes and their incoming
  objects are deleted by the retention run; removed / replaced / retired
  media stop being delivered at once and their objects are purged only
  under a configured retention window (unset = kept, policy pending);
  account anonymization deletes the account's media objects unless a
  retention hold applies (DEC-067).

---

## DEC-064 — Privacy boundaries are enforced on the server

Status:
Accepted

Decision:
Every response is an explicit DTO built field by field from a narrow row;
rows are never passed through. `PublicMemberDTO` (= MemberProfileView)
never contains surname, date of birth, phone, Instagram, referral, Dating
settings, application answers, account id, coordinates or review
information; age is derived in SQL so the date of birth never leaves the
database in a public read. Serialisation tests pin the exact key sets.
Defence in depth in the database: the `app` schema is closed to PUBLIC and
row-level security is enabled on every table with no policies, so no role
but the API's can read anything even if a grant slips in. Errors are typed
codes (UNAUTHENTICATED, MEMBERSHIP_REQUIRED, NOT_ELIGIBLE,
INTRODUCTION_EXPIRED, REACTION_ALREADY_RECORDED, MATCH_NOT_FOUND,
CONVERSATION_FORBIDDEN, BLOCKED, RATE_LIMITED …) — never raw database or
provider errors.

REVISED 2026-10-06: the earlier rule "blocks, reports and messages cannot
be deleted" is replaced by explicit retention semantics (DEC-067). Blocks,
reports and messages are protected from ORDINARY deletion by database
triggers; only the retention process, inside a transaction that marks
itself (`SET LOCAL app.retention_purge = 'on'`), can delete them, and only
under a configured policy window. Audit events and the media access log
are append-only (no UPDATE ever; DELETE only by the retention process;
TRUNCATE never).

---

## DEC-065 — Internal operations: review tooling and billing confirmations

Status:
Accepted (tooling not built). REVISED 2026-10-06: the single internal bearer
token is replaced by signed requests with scoped keys (DEC-070).

Decision:
Review decisions and payment confirmations are internal endpoints under
`/internal`, authorised by a signed internal request (DEC-070) and never by
an applicant or member session: reviewer actions (planned by the shared domain
rules, recorded with internal reason codes, audited) and billing events
(payment confirmed → ACTIVE_MEMBER with profile provisioning; membership
expired → EXPIRED), each recorded once per provider event id. No reviewer
dashboard is built; real review tooling and a billing provider adapter call
these endpoints.

---

## DEC-066 — Account lifecycle and session security

Status:
Accepted (2026-10-06)

Decision:
Account states (server): `active ⇄ suspended`, `active → deletion_requested
→ anonymized`. The simplest model that meets the requirement — no separate
"deactivated" or "deleted" row state: an anonymized account row remains
only as an opaque id other records point to; its phone number is released.

- Deletion request (`POST /v1/me/deletion`, `{ confirm: true }`, any signed-in
  applicant or member, idempotent) takes effect at once in one transaction:
  every session revoked; member profile hidden (out of discovery); waiting
  introductions withdrawn both ways; ACTIVE matches ENDED
  (`ACCOUNT_DELETED`) and their conversations closed, so no new message can
  be sent either way; membership cancelled; audited. Sign-in is refused
  afterwards, and a late payment confirmation can never activate the
  account. Anonymization is done by the retention process (DEC-067).
  No deletion UI is built yet (the endpoint exists for it).
- Suspension (internal `safety:write`): sessions revoked, sign-in refused
  after proof of possession, invisible to other members; reinstatement
  restores access. Both audited with the operator principal.
- Sessions: random 256-bit bearer tokens; only SHA-256 hashes stored.
  Absolute expiry (SESSION_TTL_DAYS, 60) and idle expiry (SESSION_IDLE_DAYS,
  30; `last_used_at` written at most every 15 minutes). Sign out (one
  token), sign out everywhere (`POST /v1/auth/sign-out-all`), rotation
  (`POST /v1/auth/session/rotate` — a token is exchanged once, keeping the
  family's absolute expiry; presenting a rotated token again revokes its
  whole session family: reuse detection).
  Every revocation records a reason (SIGN_OUT, SIGN_OUT_ALL, ROTATED,
  REUSE_DETECTED, SUSPENDED, DELETION_REQUESTED, EXPIRED). Non-active
  accounts are refused at every request, not only at sign-in. No OAuth.

---

## DEC-067 — Data retention semantics

Status:
Accepted (architecture). Retention DURATIONS are pending a policy decision.

Decision:
docs/DATA_RETENTION.md classifies every data family. Six distinct notions:
USER-VISIBLE DELETION (gone from every surface, e.g. a removed photo),
ACCOUNT DELETION (the request and its immediate effects, DEC-066),
ANONYMIZATION (identity and private data removed, opaque ids kept so
retained records stay consistent), PHYSICAL DELETION (rows/objects
destroyed), LEGAL / SAFETY RETENTION (records another person's safety may
depend on, kept under policy, with RETENTION HOLDS for open investigations),
AUDIT RETENTION (append-only trail, purged only under policy).

- Nothing is assumed to be kept forever, and no legal period is invented:
  each purge window is configuration (`RETENTION_*_DAYS`), unset = no
  automatic purge until the policy is decided.
- Retained safety records point only at anonymized ids; a deleted member's
  name becomes "Former member" wherever another member could see it.
- Operational artifacts with no policy question (abandoned uploads, used
  internal nonces, expired test-outbox codes, stale rate-limit events) are
  removed by every retention run.

---

## DEC-068 — Environments and staging

Status:
Accepted (2026-10-06). No staging infrastructure is provisioned yet.

Decision:
Four environments — development, test, staging, production — chosen by
APP_ENV; configuration only from the environment, validated at startup;
secrets never committed (server/.env.example lists names only). Staging and
production are fail-closed: development SMS senders, local storage,
DEV_SEED, "*" CORS, http public urls, weak secrets and a shared
verification bucket refuse to start; test hooks (SMS_TEST_NUMBERS,
`test:otp`) are refused in production. Staging runs the production build
on managed PostgreSQL, S3-compatible private storage, real migrations as a
release step, signed internal auth and production-shaped signed urls; it
has no fixture community, no fixed code, no reviewer shortcut in the app
and no billing control in the app. The smoke flow (server/scripts/smoke.ts)
runs only against staging, with isolated test accounts (docs/STAGING.md).

---

## DEC-069 — Observability

Status:
Accepted (2026-10-06)

Decision:
Structured JSON logs (one line per event) carry a request id
(X-Request-Id, generated or accepted when well-formed, returned on every
response and in every error body). A redactor drops sensitive keys at any
depth (codes, tokens, phone, date of birth, Dating settings, notes, urls,
signatures, bodies) and masks phone numbers in free text. Never logged:
OTP codes, session tokens, full phone numbers, dates of birth, signed or
verification media urls, Dating preferences, reviewer notes, request
bodies. Unexpected errors log the error class, database code/constraint
and stack server-side; the client receives a generic INTERNAL with the
request id. `/health/live` (process) and `/health/ready` (database,
migrations match this build, object storage) answer pass/fail only.

---

## DEC-070 — Internal service authentication and the endpoint policy registry

Status:
Accepted (2026-10-06)

Decision:
Internal endpoints accept only signed requests: key id, timestamp (±5
minutes), single-use nonce (stored, replay refused) and an HMAC-SHA256
signature over the environment (APP_ENV), method, path+query, timestamp,
nonce and body hash. Each
caller has its own key with scopes (review:write, review:media,
billing:write, safety:write, retention:run, test:otp); keys rotate by id.
This is the staging mechanism; in production, network-level service
identity (private network, mTLS or platform workload identity) is a
deployment concern that sits in front of it.

Every route is declared once in `server/src/http/endpoints.ts` with its
authentication, scope, membership requirement, ownership, authorization,
validation, response DTO, typed errors and limits; routes are registered
from that registry (authentication never depends on the path). Tests
exercise the declared policy of every endpoint, and the endpoint table in
docs/SECURITY_MODEL.md is generated from the registry and checked for drift.

---

## DEC-071 — Billing stays a boundary; staging activation is internal

Status:
Accepted (2026-10-06)

Decision:
No payment provider is selected or integrated; prices and commercial rules
are not final. The app keeps the BillingProvider boundary: release builds
show activation as not yet open; the development fixture provider exists
only in development builds. On the server, activation happens only through
the internal `billing:write` endpoint — in production the key belongs to
the future provider adapter alone; in staging it is the explicit internal
mechanism the smoke flow uses. No billing control exists in the app outside
development.

---

## DEC-072 — Realtime messaging is deferred

Status:
Accepted (2026-10-06)

Decision:
Conversations stay fetch-on-open with refresh. Nothing in the API or the
stores assumes polling forever: messages are ordered by (created_at, seq)
and idempotent per client message id, so a WebSocket, SSE or provider
realtime channel can later push the same DTOs without changing storage.

## DEC-073 — Staging infrastructure: Render, Render Postgres, AWS S3, Netgsm

Status:
Accepted (2026-10-07) — selected, not provisioned

Decision:
The staging stack (docs/INFRASTRUCTURE_DECISION.md) is:
- a Render Docker web service in Frankfurt, in a staging-only Render
  workspace on Pro;
- Render Postgres 16 in the same private network, with external access
  disabled (`ipAllowList: []`);
- AWS S3 eu-central-1 with private `media`, `verification` and log buckets,
  reached through Render OIDC workload identity (no stored keys);
- Netgsm OTP SMS over its current REST v2 endpoint, with a staging-only
  API sub-user.

The release step is Render's `preDeployCommand: node dist/migrate.mjs`;
traffic is gated on `/health/ready`. Production gets its own workspace,
database, buckets, SMS sub-user and secrets in a later phase.

Every provider sits behind an existing boundary: `DATABASE_URL`,
`ObjectStore`, `SmsProvider`, and internal billing. No vendor SDK is used
in domain code.

## DEC-074 — Least-privilege database roles and transport security

Status:
Accepted (2026-10-07)

Decision:
- **Roles.** The schema owner runs migrations only (`MIGRATION_DATABASE_URL`).
  The API connects as a login role in the NOLOGIN group `velvet_runtime`
  (migration 0010). That group has:
  - data privileges only on `app` tables;
  - no UPDATE on append-only logs;
  - read-only plans;
  - a `runtime_access` RLS policy per table.

  In staging and production the API refuses to start as a superuser, a
  BYPASSRLS role or the schema owner, and the configuration refuses
  `DATABASE_URL == MIGRATION_DATABASE_URL`. Every new table must grant
  `velvet_runtime` and add its policy. The whole server test suite runs as a
  runtime login, so a missing grant fails.
- **TLS.** `DATABASE_TLS` decides transport security
  (`off` | `require` | `verify`). It is refused as `off` outside
  development. `sslmode` in the URL is ignored.

## DEC-075 — Media reconciliation and retention dry run

Status:
Accepted (2026-10-07)

Decision:
**Media reconciliation** compares storage listings (ListObjectsV2) with the
database. It is dry run by default.
- Repair deletes only:
  - raw incoming uploads that no live upload can use;
  - objects the database already purged;
  - unreferenced media-bucket objects older than a day.
- It never deletes verification objects without a record: those are
  NEEDS_REVIEW.
- It never deletes anything under a retention hold.
- It never "repairs" a missing object by editing rows.

**Retention** gains a dry run. It counts what a run would do against the
current state; counts are an upper bound. The report includes the
configured windows, so "nothing configured" is visible.

## DEC-076 — QA accounts and the staging review fixture

Status:
Accepted (2026-10-07)

Decision:
**QA accounts.** An account created from a designated test number
(`SMS_TEST_NUMBERS`, refused in production) is marked `qa_account`
(migration 0011). QA accounts and other members are never introduced to
each other, so human testers and automated accounts stay apart.

**Review fixture.** `POST /internal/test/applications/{id}/review` (scope
`test:review`, test-only, route absent in production) moves only QA
applications. It uses the normal reviewer path, with the same transition
validation, review record and audit event; activation uses the normal
payment-confirmed path.

**Tooling.** The smoke flow, staging suites and QA seed use this fixture
instead of `review:write` and `billing:write`. So the staging runner key can
never decide about a real applicant.

## DEC-077 — Account deletion in the app

Status:
Accepted (2026-10-07) — resolves the pending "account-deletion UI placement and copy"

Decision:
The path is You → Privacy & safety → Delete account.
- The screen states the consequences in plain words, then asks for one
  explicit confirmation ("Yes, delete my account" / "Keep my account").
  There are no countdowns and no guilt copy.
- The retained-records sentence is: "Some records may be retained where
  needed for safety, security or legal obligations." No other legal claims
  are made.
- On success the server has already revoked every session. The device is
  cleared, and the launch screen shows a one-time line.
- On failure nothing changes.
- Sign-out now also revokes the server session (best effort, 3 s at most)
  before clearing the device.

Applicants (before membership) have no deletion entry point yet.

## DEC-078 — Identifiable staging builds

Status:
Accepted (2026-10-07)

Decision:
Staging builds are release builds (`EXPO_PUBLIC_APP_ENV=production`) with:
- `EXPO_PUBLIC_RELEASE_CHANNEL=staging`;
- their own app identity (`APP_VARIANT=staging`: bundle id/package
  `…membership.staging`, name "… Staging", scheme `…-staging`);
- a staging API URL.

The only in-app marker is a small "Staging" caption on the launch screen and
in You. There are no banners.

The release gate (`check-release-bundle.mjs --channel`) refuses:
- a staging build pointing at a non-staging API host;
- a production build carrying the staging channel or a staging API.

The app has no analytics SDK, so there is no analytics stream to separate.

## DEC-079 — Secrets and CI/CD for staging

Status:
Accepted (2026-10-07)

Decision:
**Secrets** live only in the platforms' secret stores:
- Render environment variables (`sync: false` or generated);
- AWS IAM (OIDC, no keys);
- the GitHub Environment `staging`.

Never in the repository, Expo source, `.env` files (ignored except
`*.example`), fixtures, logs or docs. `scripts/secret-scan.mjs` scans the
tree and every commit in CI.

**CI** runs, in order:
1. typecheck, lint, tests, build;
2. secret scan;
3. the staging-shaped rehearsal (clean-database migrations, checksums);
4. on `main`: the Render deploy hook, readiness, the real smoke flow, and the
   staging suites around a redeploy.

No production job, secret or hook exists in CI. Store publishing is manual
and out of scope.

## DEC-080 — Oversized bodies close the connection; longer keep-alive

Status:
Accepted (2026-10-07)

Decision:
A body refused for size (413) is answered with `Connection: close`.

The staging suite found the cause: when the API answered before reading the
rest of the body and kept the connection open, a later, unrelated request on
that connection was dropped mid-flight. Behind a proxy that reuses upstream
connections, that would surface as a 502.

The server's keep-alive timeout is 65 s (headers 66 s), longer than typical
proxy idle timeouts, so the proxy closes idle connections rather than the
API.

## DEC-081 — Platform-generated credentials; nobody handles a database password

Status:
Accepted (2026-10-07)

Decision:
Staging secrets are generated by the platform wherever possible, so no person
sees, types or copies them:
- **The API's database login.** Render generates `DATABASE_RUNTIME_PASSWORD`.
  The release step (`node dist/migrate.mjs`, as the schema owner) creates or
  re-asserts the login `DATABASE_RUNTIME_USER` in the `velvet_runtime` group
  and sets its password as a **SCRAM-SHA-256 verifier computed in the release
  step** — the plaintext never reaches the database server, so even a
  statement log shows only the verifier. The API derives its connection from
  the owner's URL (same host, database and TLS) with the runtime login in
  place of the owner, and still refuses the owner credential (DEC-074). The
  release step refuses to finish if the login holds anything beyond the group.
- **Internal key secrets.** `INTERNAL_KEYS_JSON` lists keys and scopes as plain
  configuration; each key's secret is its own generated variable
  (`"secretEnv": "INTERNAL_KEY_*"`). The ops key's secret is shared by the API
  and the cron through an environment group. The single secret a person
  copies is the runner key's, from Render into the GitHub Environment.
- **The staging plan** is created by the release step in staging only
  (fixture-flagged); production never gets one this way.
- **The staging URL** is Render's own `…onrender.com` address (it contains
  "staging", which every tool requires); a custom domain is optional.

The manual procedure (infra/postgres/create-runtime-login.sql with psql's
`\password`) remains for hosts without generated values. An explicit
`DATABASE_URL` still wins.

## DEC-082 — Real-provider checks run where the credentials already live

Status:
Accepted (2026-10-07)

Decision:
No provider credential is brought to a person or to this repository to run
the real staging checks. Each check runs where its credential already is:
- **Database rows** (`dist/db-check.mjs`: schema facts, match/block/
  conversation rows for the suites' pairs, an account's deletion state, row
  counts) run **inside Render** as one-off jobs on the API service — runtime
  login, TLS, read-only transaction — started by CI through the Render API.
  The staging database keeps no external access.
- **Real S3** (the provider suite and a real-browser CORS upload) runs in
  GitHub Actions as `velvet-staging-storage-test`, assumed with GitHub's OIDC
  token, allowed only test-shaped keys (`…/t<hex>…`), never a real photo. No
  AWS access key exists.
- **Drills** (database suspend/resume, point-in-time restore into a new
  instance, SMS-provider outage) run from CI through the Render API, behind
  a typed confirmation. The restore drill allow-lists only the runner's
  address on the recovery instance and deletes that instance afterwards.
- **Real SMS** is checked by the operator on their own machine with
  project-owned SIMs; codes exist only on the phones (never printed, never
  written). The log review flags any six-digit number on an authentication
  log line, so it needs no record of the codes.
- **Logs** are read through the Render logs API in CI and scanned there.

The LIKE/BLOCK race is now forced in both orders (like committed first; block
committed first) before the simultaneous rounds. Tools keep apart through QA
age bands (suite 18–23, smoke 30–39, race 40–63, deletion 64–67, seed 70–79),
and race/deletion run on their own CI runners because production-shaped OTP
limits (30 requests per address per hour) stay in force on staging.

## DEC-083 — Project-owned SIMs can be QA accounts on staging

Status:
Accepted (2026-10-07)

Decision:
`SMS_QA_REAL_NUMBERS` (staging/test only, refused in production, exact numbers,
never overlapping `SMS_TEST_NUMBERS`) lists the project's own SIMs. Their codes
go out by real SMS like anyone's, but the accounts they create are QA accounts
(DEC-076): isolated from non-QA members and movable by the staging review
fixture. That makes the full real journey possible — real SMS, the staging
app on a phone, real uploads — without a reviewer dashboard and without
letting the fixture touch a real applicant. The reviewer side runs from CI
(`staging-checks → review-fixture`), so the runner key never leaves the GitHub
Environment; a QA-only lookup (`POST /internal/test/applications/lookup`,
`test:review`, absent in production) finds the SIM's application.

## DEC-084 — A block withdraws the pair's waiting introductions at once

Status:
Accepted (2026-10-07)

Decision:
Blocking now withdraws every PENDING introduction between the two members, in
both directions, inside the block's own transaction. Before, the API already
refused and hid them (eligibility is re-checked on every read and reaction,
under the pair lock), but the rows stayed PENDING until the next read. The
staging suite's database assertions found the lag; server/test/member.test.ts
now pins the immediate withdrawal. No visible behaviour changes.

## DEC-085 — İleti Merkezi carries staging SMS while there is no company

Status:
Accepted (2026-10-07)

Decision:
Netgsm (DEC-073) needs a company registration; the project has none yet.
Staging therefore sends codes through **İleti Merkezi**, which accepts
individual accounts and individual sender names. The adapter
(`iletimerkeziSms`, server/src/auth/sms.ts) follows the official API
documentation and SDK (verified 2026-10-07): `POST
https://api.iletimerkezi.com/v1/send-sms/json`, panel-issued key + hash,
`iys: 0` (a code is not a commercial message), acceptance only on HTTP 200 +
status "200", every documented status code classified (452 → "check your
number"; everything else → the safe "couldn't send a code"). The template
stays one plain ASCII SMS. The Netgsm adapter stays for when a company
exists; switching is configuration (`SMS_PROVIDER`).

## DEC-086 — Invited friends on staging: a web link now, TestFlight later

Status:
Accepted (2026-10-07)

Decision:
The owner wants to share links with friends. Staging serves them as
**invited testers** (its documented purpose), not as a launch:
- **Web link:** the staging web build (`velvet-web-staging`, a Render static
  site) — staging channel, "Velvet Staging", the release gate in its build,
  `noindex`, no referrer; friends open it in Safari and add it to the Home
  Screen. The API allows that origin (CORS) and so does the media bucket.
- **iPhone app:** the staging build (`app.velvet.membership.staging`) through
  **TestFlight external testing with a public link** once the owner's
  individual Apple Developer membership exists (EAS profile `testflight`).
  This revises DEC-078 ("internal distribution only"). Still no App Store
  release; production stays closed.
- Native builds are gated like the web bundle (`scripts/check-build-env.mjs`,
  run by EAS): a staging build can only point at the https staging API.

Before friends are invited, three things are open (Pending Decisions): who
decides their applications and how; how Apple's beta reviewers sign in
without a fixed code; and the privacy notice (KVKK) for real people's data.

---

## DEC-087 — The owner decides invited testers' applications, from a tool on their own computer

Status:
Accepted (2026-10-07)

Decision:
On staging the owner is the membership team: they decide invited testers'
applications themselves (the owner: "başvuru ben onaylıcam"), with a small
terminal tool on their own computer — not a web dashboard, not CI, not the
QA review fixture (which still moves QA accounts only).
- **Reading** gets its own scope, `review:read`, and two internal routes: the
  queue (`GET /internal/reviewer/applications` — first name, age, city,
  status and the actions open; no surname, phone number, answers or media)
  and the application view (`GET /internal/reviewer/applications/:id` — the
  private application as the membership team may see it). Phone numbers —
  the applicant's and the referrers' — are never part of either. Every open
  of an application view is written to the append-only
  `application_access_log` (key id + reviewer id; ids only), removed only by
  the retention process under the audit window. These routes exist in every
  environment: production review will need them too.
- **Photos** open one at a time through the existing `review:media` route
  (10-minute links for application photos, 2 for identity photos; every
  open in `media_access_log`). The tool opens them in the browser or, with
  `--baglanti`, prints the links; it never downloads or stores them.
- **Decisions** go through the one reviewer path (`review:write`, the shared
  lifecycle rules, an audit event and a review record with the reviewer id).
  The tool always shows whose application it is and asks before acting
  (`--evet` when non-interactive).
- **The key** is a fourth internal key, `reviewer` (review:read,
  review:write, review:media, membership:complimentary), its secret generated
  by Render (`INTERNAL_KEY_REVIEWER_SECRET`) and typed once — hidden — into
  the tool's setup on the owner's computer, never into chat, CI or a file in
  the repository. The tool keeps it in `~/.velvet-review.json` (mode 0600)
  with the API address and the reviewer name; the ids of the last `liste`
  (with its time — numbers older than two hours are refused) are the only
  other thing it writes.
- The tool (`server/scripts/review.ts` → `dist/velvet-review.mjs`) is one
  self-contained file for plain Node 22, Turkish, and refuses any API that is
  not https staging (or loopback, for the rehearsal); it signs for staging.

---

## DEC-088 — Invited membership on staging: complimentary, never a payment

Status:
Accepted (2026-10-07)

Decision:
An approved invited tester's membership is started by the owner as an
**invited (complimentary) membership** (the owner's choice: "Ücretsiz
davetli üyelik"). It is not a billing integration and not a fake payment:
- `POST /internal/reviewer/applications/:id/invited-membership`
  (`membership:complimentary`) moves APPROVED or MEMBERSHIP_PAYMENT_REQUIRED
  → ACTIVE_MEMBER through the normal lifecycle — each move validated and
  audited with the reviewer as the actor (metadata `activation:
  complimentary`) — and provisions the member profile exactly as activation
  does.
- The membership row says so: `activation = 'complimentary'`,
  `granted_by` = the reviewer, no `renews_at`. **No billing event is
  recorded**, so nothing anywhere reads as "paid". A billing confirmation
  cannot re-activate it, and a paid membership is never turned into an
  invited one. Repeating the call answers the current state.
- The member sees it plainly: Membership → "Invited membership … There is
  nothing to pay." (the reviewer's name is never sent to the member).
- **Staging only**: `membership:complimentary` is a test-only scope (refused
  in production configuration) and the route is absent in production.
  Whether production ever has complimentary memberships is a pending
  decision. DEC-071 stands: no commercial billing exists.
- An invited membership does not end by itself (nothing renews); ending one
  is a later decision (today: suspension, or account deletion).

Resolves the Pending Decision "how invited testers' applications are decided
on staging".

---

# Pending Decisions

The following are intentionally not finalized yet:

- final brand name
- logo
- final font family
- exact membership price
- membership tiers
- exact approval criteria
- reviewer weighting model
- exact waitlist re-review cadence
- reapplication policy
- exact photo minimum/maximum (implemented as 3–6)
- exact interest catalogue (implemented as a curated list of 31)
- exact intent taxonomy
- whether music is part of profiles
- whether short video is accepted in Stage 2 (media model already supports it)
- Dating taxonomy beyond Woman / Man / Non-binary / Self-describe and Women / Men / Non-binary people / Everyone (DEC-058), and the age-range bounds (implemented 18–80)
- billing provider, price, currency and billing periods (one development fixture plan implemented)
- identity verification provider (VERIFY_IDENTITY currently collects a private photo for manual review)
- whether a waitlisted applicant may update information without a request
- alternate application route for applicants without Instagram (website / portfolio / LinkedIn)
- exact member navigation beyond Home / Messages / You
- Friendship / Community discovery surfaces (Today's Introductions is Dating-only in V1, DEC-050)
- production hosting accounts (staging providers selected in DEC-073; production gets its own workspace, database, buckets and SMS sub-user)
- whether staging gets a custom domain (today: the onrender.com addresses — DEC-081, DEC-086)
- whether production offers complimentary memberships, and how an invited membership ends (staging: DEC-088)
- how Apple's TestFlight beta reviewers sign in, without a fixed one-time code
- the privacy notice (KVKK aydınlatma metni) shown before invited testers apply
- SMS provider account and contract (Netgsm REST v2 adapter verified against the official API reference, DEC-073; account, sender header and package pending)
- data-retention durations for every class in docs/DATA_RETENTION.md, and the account-deletion grace window (DEC-067)
- production service-to-service / admin authentication layer in front of signed internal requests (DEC-070)
- whether ENDED pairs may ever be reintroduced (`rematchAfterDays`, currently never) and an unmatch feature (DEC-060)
- account deletion entry point for applicants before membership (members: DEC-077)
- realtime delivery for messages (polling today; designed for a later push channel)
- daily introduction quantity and curation method (6 per day implemented)
- whether a pass can ever be undone; unblocking
- report review workflow and moderation tooling
- public display-name policy (first name vs first name + initial) — both supported in `createPublicProfile`
