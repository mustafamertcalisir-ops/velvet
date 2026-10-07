# Phase 1 completion report — admission vertical slice

Date: 3 October 2026

## Inputs

Read: project instructions, DECISIONS, DATA_MODEL, TRUST_AND_PRIVACY,
BUILD_PHASES, TESTING_AND_QA, COPY_AND_TONE, ADMIN_REVIEW_MODEL,
raya-notes, SKILLS_AND_SETUP.

**Not available:** PRODUCT.md, DESIGN.md, docs/ADMISSION_FLOW.md,
docs/SCREEN_MAP.md, and visual reference screenshots were not in the project.
The project instructions covered the same ground; the design analysis
(`docs/DESIGN_ANALYSIS.md`) should be revisited once references are uploaded.

No repository existed, so a new Expo SDK 57 + TypeScript + Expo Router
project was created (DEC-021). No existing architecture was replaced.

## Files changed

All new. See `README.md` for the map. Key files:

- Lifecycle: `src/domain/admission/status.ts`, `stage1.ts`, `statusStages.ts`, `access.ts`
- Models: `src/domain/models.ts`, `src/domain/profile/publicProfile.ts`
- Validation: `src/domain/validation/{name,dateOfBirth,instagram,phone}.ts`, `src/domain/text/search.ts`
- Geo: `src/domain/geo/{countries,countries.generated,cities}.ts`, `scripts/generate-countries.mjs`
- Services: `src/services/api/types.ts`, `src/services/mock/mockAdmissionApi.ts`, `src/services/storage.ts`
- State: `src/state/admission/{store.ts,AdmissionProvider.tsx}`
- Navigation: `src/navigation/{routes.ts,Guard.tsx,StepGuard.tsx,useStep.ts,errors.ts}`
- Design: `src/design/{tokens,typography,useReducedMotion}.ts`
- Primitives: `src/components/*` (13)
- Routes: `src/app/**` (18)
- Tests: 7 suites under `__tests__/`, `e2e/run.mjs`
- Docs: `docs/DESIGN_ANALYSIS.md`, `docs/DECISIONS.md` (DEC-021–029 added), this report

## Architecture created

- **One authoritative status.** `AdmissionState.status` in the store. Every
  client-initiated change goes through `transition()`, which validates
  against an explicit transition table. Statuses after submission are only
  adopted from the server. No lifecycle booleans exist.
- **Separated models.** UserAccount, MembershipApplication,
  PrivateApplicationData, PublicMemberProfile, Membership — separate types.
  The client stores application metadata *without* status so the status
  cannot exist twice.
- **Public-profile firewall.** `createPublicProfile()` takes a narrow
  whitelisted source, refuses any status except ACTIVE_MEMBER, and a
  compile-time assertion fails `tsc` if a private field is ever added to
  `PublicMemberProfile`.
- **Lifecycle-driven routing.** `homeRoute(state)` maps status → route.
  `Guard` redirects the focused screen whenever the lifecycle no longer
  allows it. `/member/*` is behind `canAccessMemberProduct(status, membership)`.
- **API port + mock backend.** `AdmissionApi` interface; the mock persists
  its own "server" namespace, re-validates submissions server-side
  (including 18+), enforces OTP limits, is idempotent, and audits events.
  It never decides admission; a dev-only reviewer fixture moves status
  through `transition()`.
- **Persistence.** Draft, status, pending submission and OTP challenge
  survive restart (AsyncStorage). Sign-out wipes private data from the device.

## Application states implemented

| State | Phase 1 behaviour |
|---|---|
| UNAUTHENTICATED | Launch, phone entry |
| PHONE_VERIFICATION | OTP entry; survives restart; change number |
| APPLICATION_DRAFT | Intro + 7 questions + review; persisted; resumable |
| APPLICATION_SUBMITTED | In-flight submit; retry with same key; resumes after restart |
| APPLICATION_RECEIVED | Received moment → Application Status |
| UNDER_REVIEW … NOT_ADMITTED | Modelled, routed to Status, copy for each; reachable only via server/dev fixture |
| MEMBERSHIP_PAYMENT_REQUIRED, ACTIVE_MEMBER, SUSPENDED, EXPIRED | Modelled + guarded; no UI (later phases) |

## Screens implemented

Launch → Phone → OTP → Application intro → First name → Last name →
Date of birth → Instagram → Country → City → Referral → Review (letter) →
Submit confirmation → Application received → Application status.
Plus a guarded `/member` placeholder and a lifecycle-aware not-found route.

## Validation

- Names: Unicode letters (Turkish incl.), apostrophes, hyphens; trimmed; case untouched.
- DOB: real calendar date, not future, ≤110 years, **≥18** (re-checked at submit and on the server); leap-day rule DEC-025.
- Instagram: `@handle`, bare handle, or profile URL → normalised handle; post links rejected; explicit opt-out.
- Phone: libphonenumber validation for any country; TR default; paste of `+…` numbers accepted.
- Country/city: search folds Turkish characters (`istanbul` → İstanbul); duplicate names disambiguated by region; unlisted city can be typed.
- Referral: name + valid phone; no duplicates; no self-referral; max 2; numbers masked on screen.
- Draft invariants: invalid input never overwrites a valid answer; country change clears city; nothing editable after submit.

## Tests / checks

| Check | Result |
|---|---|
| `tsc --noEmit` (strict, noUncheckedIndexedAccess) | pass |
| `expo lint` (incl. React Compiler rules) | pass, 0 warnings |
| Jest — 7 suites | **104 / 104 pass** |
| Web export | pass |
| iOS + Android Hermes bundles (`expo export`) | pass |
| `expo-doctor` | 21 / 21 |
| Turkish glyph check (both families) | pass |
| E2E flow in Chromium, 375×667 (reduced motion) and 430×932 | **60 / 60 pass** |

The seven required verification points:

1. Submitted applicant cannot enter the member product — E2E: `/member` redirects to status in DRAFT, RECEIVED and UNDER_REVIEW; unit: access guard over all 18 states.
2. Draft data persists — store test across restart; E2E page reload on Review.
3. Under-18 DOB rejected — unit (exactly-18 vs one day short), store (not committed), E2E (UI message, draft unchanged), mock server re-check.
4. Back navigation does not corrupt data — E2E: edit from Review, type invalid value, go back → draft unchanged; country change clears city then returns to Review.
5. Status survives restart — store test + E2E reload in RECEIVED; sign-out/sign-in restores from server.
6. Private fields not exposed to public models — compile-time key assertion + runtime test that serialised profiles contain no surname, DOB, Instagram, phone or referral.
7. No fake admission result — server snapshot after submit: one application, `APPLICATION_RECEIVED`, `decisionAt: null`, no membership; copy scan for congratulations / queue / % / countdown.

## Visual QA

Rendered with react-native-web in headless Chromium and inspected from
screenshots at 375×667 and 430×932. Issues found and fixed during QA:

- Date fields overlapped at 375pt (web inputs' intrinsic min-width) → `minWidth: 0`.
- Status text became illegible over bright sky when scrolled → photo now scrolls with content.
- Selection tick sat beside the label instead of right-aligned → fixed.

**Not visually verified:** native iOS/Android rendering, the iOS keyboard,
Android edge-to-edge keyboard behaviour, native blur, VoiceOver/TalkBack.

## Known limitations

- **No real backend or SMS.** Mock backend only; the OTP is fixed in dev.
- **Device storage is not encrypted.** Draft (surname, DOB) is in AsyncStorage. Use encrypted storage before real applicant data.
- **Not run on a simulator or device.** Native keyboard avoidance, swipe-back, SMS autofill, haptics and screen-reader handling of the Review letter's inline links still need device QA.
- Android hardware back from the first application screen can briefly land on the (now invalid) phone screen, which redirects forward again.
- Status refresh is pull-to-refresh / app-foreground only; no push notifications.
- Referral requests are stored but not matched to members (server work).
- City list is seed data (81 TR provinces + ~100 international cities); typed cities are accepted.
- English copy only; strings centralised in `src/copy/en.ts` for Turkish localisation. Instrument Sans lacks ₺ (relevant to pricing later).
- Dynamic Type is capped (×1.3 display, ×1.8 body) but not tested at the largest accessibility sizes.
- Screen-capture mitigation not yet implemented.
- Photography and wordmark are placeholders (DEC-028).

## Next logical phase

**Phase 2 — Application Status hardening**, before the extended application:

1. Run the slice on iOS and Android (simulator + one small and one large device) and close the device-only items above.
2. Define the real `AdmissionApi` contract (auth, OTP provider, submit, status) and move the mock behind the same interface.
3. Status updates via push notification ("There's an update to your membership application."), plus foreground refresh.
4. Promote the dev reviewer fixture into proper Phase 4 test fixtures with audit assertions.
5. Encrypted on-device storage for the draft.

Do not start the extended application until 1–2 are done.
