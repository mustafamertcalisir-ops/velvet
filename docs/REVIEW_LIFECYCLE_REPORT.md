# Phase 4 — Membership review lifecycle — report

Pass date: 5 October 2026. Admission now runs end to end, from phone
verification to one of four outcomes, plus the boundary into membership
activation. Not built: the member product, discovery, chat, Places, Travel,
Directory, a real payment provider, or a production reviewer dashboard.

## Stage 2 fixes
- **Interest rooms:** "Table & travel" is now "Living" (Cooking, Gardening, Travel, Wine).
  - When the rooms fit, they spread across the full width; label size is unchanged at 14pt.
  - When they don't fit (large text), the row scrolls, a fade marks the hidden edge, and the active room is kept in view.
  - E2E checks that all five rooms are fully on screen at 375, 393 and 430, with selection counts.
- **Dating preferences (DEC-040):** two steps after intent, only when Dating is chosen.
  - Steps: "Who would you like to meet?" and "What age range feels right?".
  - The progress counter adjusts: 7 steps without Dating, 9 with it.
  - Unchoosing Dating clears any saved answers.

## Lifecycle (DEC-041)
Transitions are validated centrally by `transition()`. Reviewer actions are planned by `planReviewerAction()`:

| From | Reviewer actions |
|---|---|
| APPLICATION_RECEIVED | start review |
| UNDER_REVIEW | request extended · request information · waitlist · not admit |
| FINAL_REVIEW | approve · waitlist · request information · not admit |
| WAITLISTED | reopen (→ UNDER_REVIEW, or → FINAL_REVIEW if Stage 2 exists) · not admit |

Transitions driven by the applicant or the system:
- MORE_INFORMATION_REQUIRED → the stage that asked (the applicant sends the update).
- APPROVED → MEMBERSHIP_PAYMENT_REQUIRED (the applicant taps Continue).
- MEMBERSHIP_PAYMENT_REQUIRED → ACTIVE_MEMBER (the billing provider confirms to the server).

The `TRANSITIONS` table itself is unchanged. New route zone: `membership` (MEMBERSHIP_PAYMENT_REQUIRED → `/membership`).

## Files

New:
- Domain: `src/domain/admission/{audit, informationRequests, review}.ts`, `src/domain/membership/plan.ts`.
- Billing: `src/services/billing/billing.ts`.
- Components: `src/components/{AgeRangeField, InformationRequestList}.tsx`.
- Routes: `src/app/extended/{meet, age-range}.tsx`, `src/app/application/request/[id].tsx`, `src/app/membership/{_layout, index}.tsx`.
- Tests: `src/state/__tests__/reviewLifecycle.test.ts`, `src/domain/__tests__/reviewDomain.test.ts`, `e2e/outcomes.mjs`.
- Docs: `docs/DATA_MODEL.md`, `docs/REVIEW_LIFECYCLE_REPORT.md`, and screenshots `docs/screenshots/admission-outcomes-{standard,widths}.jpg`.

Changed:
- Domain: `stage2.ts` (dating model and the steps that depend on answers), `status.ts` (membership zone), `statusStages.ts`, `models.ts`, `publicProfile.ts`.
- Services and state: the mock server, the API port, `src/services/index.ts`, the store, `AdmissionProvider`.
- Screens: `useExtendedStep`, `routes.ts`, `status.tsx`, `review.tsx`, `useStatusAction`.
- Shared UI and assets: `ApplicationBand`, `InterestCurator`, `DevReviewPanel`, `photography.ts`, `preparePhotos.ts` (verification photo), `app.json` (camera permission text), copy.
- Gates and docs: `scripts/check-release-bundle.mjs`, `e2e/run.mjs`, `e2e/stage2.mjs`, `docs/DECISIONS.md` (DEC-040 to DEC-047), `docs/ADMISSION_FLOW.md`.

Three existing assertions now use the new uppercase audit event names; what they assert is unchanged. One route test now expects `/membership` for MEMBERSHIP_PAYMENT_REQUIRED (DEC-046).

## Checks (final run)
- Typecheck and lint: clean.
- Jest: 181 / 181 in 16 suites, of which 29 are new.
- QA and production web builds: both pass.
- Release gate: the production env is inlined, no dev flags are set, and the reviewer/billing fixture code is absent from the bundle (now enforced by the gate).
- E2E: 427 / 427 checks. Three widths run phone → Stage 1 → Stage 2 (with and without Dating) → more information → waitlist → reopen → approved → membership → member area, plus a not-admitted branch from saved state. A long-name / typed-city Stage 1 run and a production-bundle check run as well.
- Native iOS and Android bundles export; `expo-doctor` passes 21 / 21; font glyph check passes. No QA fixture image appears in any bundle.

## Known limitations
- Web is a proxy for native. Camera capture, the iOS keyboard, VoiceOver's adjustable control and haptics were not run on devices. Larger text was approximated with 130% page zoom on web; that is not Dynamic Type.
- VERIFY_IDENTITY collects a private photo for manual review. There is no identity-verification provider yet.
- "Confirm date of birth" is deliberately not editable through a request; identity verification covers it.
- No billing provider. Release builds show activation as not yet open. Pricing is a labelled development fixture.
- There is no reapplication policy, so NOT_ADMITTED is terminal and its copy promises nothing.
- Reviewer tooling exists only as the development fixture. A production dashboard and reviewer roles and permissions come later.
- The progress counter on the intent step reads "7 of 7" until Dating is committed; the next step then shows "8 of 9".
