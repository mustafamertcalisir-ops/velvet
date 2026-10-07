# Stage 2 experience + visual refinement — report

Pass date: 3 October 2026. Scope: visual and interaction quality of Stage 2
and the status family. The admission state machine, guards, persistence,
submission and privacy model are unchanged. Phase 4 has not been started.

## Files changed

New
- `docs/RAYA_VISUAL_ANALYSIS.md`, `docs/STAGE2_VISUAL_REPORT.md`
- `src/domain/profile/profilePresentation.ts`: whitelist builder, `photo | video` media model, intent phrase and sentence
- `src/components/profile/ProfileView.tsx`, `src/components/profile/ProfileMediaStage.tsx`
- `src/components/Glass.tsx`, `src/components/ActionSheet.tsx`, `src/components/PhotoCollage.tsx`
- `src/components/InterestCurator.tsx`, `src/components/WritingField.tsx`
- `src/components/ApplicationBand.tsx` (shared band + `Kicker`), `src/components/FocusVisibility.tsx`
- `src/domain/__tests__/profilePresentation.test.ts`
- `e2e/fixtures/photo-1…4.jpg` + `README.md` (QA only, never bundled)
- `docs/screenshots/phase1-refined-v2-standard.jpg`, `stage2-refined-v2-standard.jpg`, `stage2-refined-v2-widths.jpg`

Changed
- `src/domain/admission/stage2.ts` (`INTEREST_GROUPS`) and its test
- `src/design/typography.ts` (`heroAnswer`, `writing`); `src/design/tokens.ts` (selection in Pearl)
- `src/components/TextField.tsx` (hero size, hidden label, wrapping one-line answers, caption, focus visibility)
- `src/components/ChoiceList.tsx` (typographic selection, inline follow-up)
- `src/components/ScreenShell.tsx` (keeps the focused field visible when the view shrinks)
- `src/components/SearchableList.tsx` (Pearl tick)
- `src/app/extended/{intro, photos, occupation, work-context, interests, preview, review}.tsx`, `src/screens/LongAnswerStep.tsx`
- `src/app/application/{status, received, sent}.tsx` (kicker, shared band)
- `src/copy/en.ts`
- `e2e/run.mjs`, `e2e/stage2.mjs`
- `docs/DECISIONS.md` (DEC-033 amended; DEC-034 to DEC-039 added; pending list), `docs/DESIGN_ANALYSIS.md`

Removed: `PhotoGrid.tsx`, `InterestPicker.tsx`, `LongTextField.tsx`.

## Stage 2 screens

| Screen | Before | Now |
|---|---|---|
| Intro | A question screen listing what's involved | Composed like Status: same photograph band, "Application update" kicker, serif headline, the four-stage line, then three plain facts (what it involves / time / who sees it) |
| Photos | Utility grid | Contact-print collage: the lead frame is two-thirds wide, empty frames are quiet unlabelled fills, and only the next frame carries a mark. Footer counts down "Add 3 more photos" |
| Photo menu | — | Thumbnail + "Photo 4 of 4 / Shown fourth", grouped actions on hairlines, destructive action in its own group, Cancel apart |
| Occupation | Labelled field | The answer is the screen: 32pt sans, no box or visible label, wraps instead of scrolling, steps down for long titles. "Shown beneath your name, as you write it." |
| Work context | Radio rows + separate field | Typeset answers; the chosen one steps forward on an Ink band, and the studio-name field opens inside it |
| Known for / About you | Filled text box | A writing page: 19/28 sans, no box, grows with the answer, one hairline with a note and a live count. About-you says it isn't part of the profile |
| Interests | 31 tiles | Curated collection (see below) |
| Intent | Radio-style list | Same typographic choice treatment, title + one-line description, multi-select |
| Preview | Card-like | Full-screen profile (see below) |
| Review | Admin list | A composed portrait: lead photo large with two beside it, serif first name + age, occupation, workplace · city, separate "Edit occupation / Edit workplace", then the written answers on hairlines with Edit |
| Receipt / Status | — | Same kicker system; one family with Received |

## Profile preview

- Built only by `buildProfilePreview`. It has no parameter through which surname, date of birth, phone, Instagram, referral or reviewer data could arrive.
- Lead frame: full-bleed photo with identity on its lower edge (serif first name, sans age, occupation, city, intent sentence). Glass controls only: back, and "Only you can see this".
- Below it, one editorial column alternates words and photographs: Known for, then photo 2, then interests as a line, then the remaining photos. Scroll is the only navigation, and each photo appears once.
- The media model is `photo | video`, so video slots into the lead frame or the column later.

## Interests

Five rooms (Culture, Ideas, Music, Outdoors, Table & travel), at most 8 rows each, in a single column. The chosen collection is set as the sentence it becomes on the profile ("Architecture, Swimming and Jazz."), with "3 / 8". Room tabs show their chosen counts. At 8, the other rows step back and a note explains the limit; E2E confirms a ninth is refused.

## Tests and checks (final run)

- `tsc --noEmit`: clean. `expo lint`: clean.
- Jest: 152 / 152 in 14 suites (new: interest groups cover the catalogue exactly once; intent phrase).
- Web QA and production exports. `check:release`: production env inlined, no dev flags.
- E2E: 277 / 277. Three widths through Stage 1 and Stage 2, plus a Stage 1-only long-Latin-name / typed-city run, plus the production bundle.
- New E2E checks:
  - the preview shows the first name and an age, and never surname, Instagram, phone, referral or the about-you answer;
  - each non-lead photo appears exactly once;
  - 3 and 8 interests, and the ninth refused;
  - the long occupation stays inside the screen;
  - the long studio name is kept intact;
  - the review shows the first name only.
- Native iOS + Android bundles export. `expo-doctor`: 21 / 21. Font glyph check: ok.
- QA fixture photos: none of their hashes appear in any web or native export.

## Visual QA

Rendered and inspected at 375 × 667 (reduced motion), 393 × 852 and 430 × 932, plus simulated-keyboard viewports.

Fixed during inspection:
1. Empty collage read as an upload utility. Dashed "+" frames became quiet fills.
2. The first photo action wrapped. Now "Make this your first photo".
3. Web textarea opened two rows tall, leaving a gap under the occupation. It now sizes to its content.
4. "Edit occupationEdit workplace" ran together.
5. The review repeated "Here for" in the label and the value.
6. The preview showed photos twice (carousel + column). Now scroll only.
7. With the keyboard open on a small screen, the revealed studio field sat behind the footer. The shell now scrolls it into view, including its caption.

## Known limitations

- Web is a proxy for native. Native keyboard, blur, gestures, haptics and screen readers were not run on devices.
- Fixture photos are stock-like Unsplash portraits. The photo-2 fixture has a small logo on a shirt; it is QA-only.
- Not built: dating preferences (only when Dating is chosen; optional), video upload, education, portfolio, additional verification, Phase 4 admin review.
- The interest catalogue and room names remain provisional. "Table & travel" scrolls off the tab row on narrow screens when counts are shown.
- On web, `field-sizing: content` drives auto-growing fields (current Chromium and Safari). Older browsers fall back to a fixed height.
