# Phase 1 alignment + Stage 2 report

Date: 3 October 2026

## Inputs

Re-read PRODUCT.md, DESIGN.md, ADMISSION_FLOW.md, SCREEN_MAP.md,
raya-notes.md (newly supplied) plus TRUST_AND_PRIVACY, COPY_AND_TONE,
DATA_MODEL, DECISIONS, BUILD_PHASES and TESTING_AND_QA. Inspected the Phase 1
source and its screenshots. **No visual reference screenshots were supplied**
(only markdown files arrived; the Project has no image uploads).

Preserved unchanged: lifecycle table, transition rules, store architecture,
idempotent submission, persistence, applicant/member separation, guards and
all Phase 1 tests (none weakened; three were updated where a decision changed
the expected behaviour — Instagram opt-out, extended route zone — and new
assertions were added alongside).

## Visual changes

- **Type roles split** (DEC-032): serif only for questions, major titles,
  receipt/status headlines and the Stage 1 read-back; UI sans for answers,
  labels, helper copy, validation, lists, status details and controls.
  Helper text up from 14 to 15; labels 13 → 14. Long answers step down in size
  instead of clipping.
- **Tokens aligned with DESIGN.md**: control radius 12, sheets 24, surface
  dark `#1B1B1E`, muted `#77777D` (non-text only); accent limited to current
  stage, validation and selection; caret and decorative accent rule removed.
- **Buttons**: 54pt, semibold label; pressed darkens; disabled is a distinct
  dark fill; secondary is a quiet fill (no outline).
- **Phone**: country code is its own labelled column with matching rule;
  helper text full-width.
- **OTP**: six positions grouped 3+3, dot placeholders, visible caret on the
  active position, 2pt focus rule, error tint, number kept on one line.
- **Progress**: numeral "3 of 7" + 2pt track aligned to the gutter.
- **Review**: shorter, less literary sentences; private details marked with a
  plain note under the relevant sentence; referral shown as "Kerem A.".
- **Submission sheet**: backdrop fades, sheet rises 32pt in 220ms; serif
  title; primary + quiet "Go back"; safe-area padding.
- **Received / Status**: graded photography (scripts/grade-photography.py);
  text on near-solid ground; Status reuses the Received photograph as a band,
  then headline, sequence, and three facts (submitted / your next step /
  updates). Four-stage sequence fits on one line at 375pt.

## Product decisions updated (docs/DECISIONS.md)

- DEC-022 revised — referral privacy (short name, generic state, no number shown).
- DEC-023 replaced — Instagram required in V1; opt-out removed.
- DEC-025 withdrawn — 29 Feb handling is implementation detail.
- DEC-027 expanded — status home composition.
- DEC-028 — brand name not finalised.
- New: DEC-030 dev tooling flags, DEC-031 device data minimisation,
  DEC-032 typography roles, DEC-033 Stage 2 scope.

## Privacy changes

- Referral phone numbers are never shown back, even masked.
- After Stage 1 acknowledgement the device drops DOB, Instagram and referral
  details; after Stage 2, all extended answers and photo references.
- Age/city for display come from the server (`ApplicantSummary`).
- Photos are re-encoded before upload (strips EXIF, including GPS).
- Profile preview shows only first name, derived age, occupation, city,
  interests and a "known for" excerpt.
- Dev tooling cannot appear in production; found and fixed a Metro cache
  issue that inlined dev flags into a production bundle; `check:release` gate.

## Application states touched

UNDER_REVIEW → EXTENDED_APPLICATION_REQUIRED (server/dev fixture) →
EXTENDED_APPLICATION_DRAFT (server, on "Continue application") →
EXTENDED_APPLICATION_SUBMITTED (client, with idempotency key) →
FINAL_REVIEW (server). New route zone `extended`. No path to approval added.

## Tests

| Check | Result |
|---|---|
| Typecheck | pass |
| Lint | pass |
| Jest (13 suites) | 147 / 147 |
| E2E: Stage 1 + Stage 2 at 375 / 393 / 430pt + production bundle | 193 / 193 |
| Release bundle gate | pass (and correctly fails the QA bundle) |
| Web QA + production exports | pass |
| iOS + Android Hermes bundles | pass |
| expo-doctor | 21 / 21 |
| Turkish glyph check | pass |

## Visual QA

Rendered with react-native-web in headless Chromium at 375×667 (reduced
motion), 393×852 and 430×932, one applicant per width (Şebnem
Karaosmanoğlu-Büyükçekmeceli / Kahramanmaraş; Çağla Öztürk-Işıl / Muğla →
Berlin; Alexandra-Charlotte Montgomery-Fitzwilliam Ainsworth /
Saint-Rémy-de-Provence). Every Stage 1 and Stage 2 screen plus validation,
error, failure and "keyboard" states (viewport shortened by 291pt — a
simulation, not a native keyboard).

Fixed during QA: clipped long surnames; doubled "@" in Instagram; "Use
'kahraman'" shown despite a listed match; "Kerem A.." double stop; invisible
secondary on the sheet; phone number breaking across lines; four-stage
sequence crowding; story-style ticks replaced by a numeral counter.

## Screenshots generated

`docs/screenshots/phase1-refined-{small,standard,large}.jpg`,
`docs/screenshots/stage2-{small,standard}.jpg`; full set (~140 PNGs) from
`npm run e2e` into `e2e/screenshots/`.

## Known limitations

- No reference screenshots yet; analysis is from written references.
- Not run on iOS/Android hardware or simulators: native keyboard avoidance,
  swipe-back, blur, haptics, SMS autofill, photo-library permission flow and
  screen-reader behaviour of the read-back's inline links need device QA.
- Mock backend only; photos stored as data URIs in device storage for the
  mock (real uploads should go to object storage with signed URLs).
  Removed photos are not deleted server-side in the mock.
- Device storage is not encrypted.
- Typed routes regenerate only via `expo start`.
- Stage 2 not yet built: dating preferences (EXT-08), education (EXT-09),
  portfolio/website (EXT-10), additional verification (EXT-11);
  MORE_INFORMATION_REQUIRED has status copy but no resolution flow.
- English copy only (centralised in `src/copy/en.ts`).

## Stage 2 progress

Done: entry on Status (STATUS-03), EXT-00 intro, EXT-01 photos (3–6,
upload/failure/retry/reorder/remove/moderation-pending), EXT-02 occupation,
EXT-03 work context, EXT-04 what you do, EXT-05 about you, EXT-06 interests,
EXT-07 intent, EXT-12 preview, EXT-13 review, submit → FINAL_REVIEW,
EXT-14 receipt, STATUS-04 Final review. Draft persists and resumes at the
first unanswered step; Stage 1 stays locked; member area stays closed.

## Next logical step

Phase 4 (review lifecycle) is now the bottleneck: proper reviewer fixtures
with audit assertions, and the MORE_INFORMATION_REQUIRED resolution flow
(specific, narrow requests that return the applicant to the right review
state). In parallel, run the full flow on iOS and Android devices, and add
EXT-08 dating preferences once the intent taxonomy is settled.
