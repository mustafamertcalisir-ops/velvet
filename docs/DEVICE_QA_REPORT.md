# Device QA report — iPhone and Android

**Status: BLOCKED.** No physical iPhone or Android phone was available to
this phase, and no staging build exists yet: there is no Expo/EAS, Apple
Developer or Google Play Console account, and no deployed staging API.

**Nothing in this file has been tested on a device.** The web E2E
(Playwright) covers the same screens at phone widths, but it is not a
substitute here: it cannot exercise the native keyboard, OTP autofill,
safe areas, the photo picker, haptics, gestures, the app lifecycle or the
platform screen readers.

What is ready is the protocol below. Run it with the staging build (eas.json
profile `staging`, DEC-078) against the deployed staging API, then record
the results in the tables.

## Builds to test

| | iPhone | Android |
|---|---|---|
| Build | EAS `staging` profile, internal distribution | EAS `staging` profile, internal distribution (APK/AAB) |
| App id | `app.velvet.membership.staging` ("Velvet Staging") | `app.velvet.membership.staging` |
| API | `https://api-staging.<domain>` | same |
| Device / OS | _to record_ | _to record_ |

Accounts:
- For the full journey with real SMS, use a **project-owned SIM** listed in
  the server's `SMS_QA_REAL_NUMBERS` (DEC-083): its codes arrive by real SMS
  and its application can be moved by the review fixture. The reviewer side
  runs from GitHub: Actions → `staging-checks` → `review-fixture` (choose the
  SIM and the action; each run prints the transition's request id).
- For QA-account flows, use the QA set: `node dist/qa-seed.mjs list`, and
  `otp <number>` to read the code after requesting it on the device.

## Checklist (record PASS/FAIL, device, OS version, notes)

| # | Area | Steps | Expected |
|---|---|---|---|
| 1 | Staging marker | Launch | Small "Staging" caption under the sign-in action; also at the bottom of You. No banner anywhere |
| 2 | OTP autofill | Request a code with the real SIM | iOS: code suggested above the keyboard (`textContentType="oneTimeCode"`). Android: autofill suggestion (`autoComplete="sms-otp"`); if none, manual entry and paste work. Record which |
| 3 | Keyboard | Phone, OTP, names, city search, Stage 2 writing fields | The focused field and primary action stay visible above the keyboard; no layout jump; the return key moves forward where expected |
| 4 | Safe areas | Every screen, notch/Dynamic Island and gesture-bar devices | Nothing under the status bar or home indicator; the tab bar clears the home indicator |
| 5 | Photo picker | Stage 2: add 3 photos (library and camera); identity photo (camera) | Permission prompts use the app's wording; limited-library access works (iOS); large HEIC/JPEG are resized before upload |
| 6 | Upload | Same, on Wi-Fi and on cellular | Each photo uploads directly to storage (signed URL) and completes. A failed upload shows "That photo didn’t upload. Try again." and retry works |
| 7 | Metadata | After upload | The member's own view shows the photo. (Stripping is verified server-side in staging-suite) |
| 8 | Haptics | Like; a mutual match (src/lib/haptics.ts) | One light tap for a like, one success notification for a match, nothing else; none when the system setting is off |
| 9 | Gestures | Back-swipe on stacks; disabled where the layout says so (match, delete account) | No accidental exits from the match screen or the deletion confirmation |
| 10 | Background/foreground | Request OTP → background → foreground; mid-Stage-2 → background 10 min → foreground | State kept; drafts kept; no duplicate submission |
| 11 | Session persistence | Kill the app and reopen | Still signed in; lands on the correct lifecycle screen |
| 12 | Logout | You → Sign out | Back to launch. The server session is revoked (an old token is refused: check with staging-suite or the API logs) |
| 13 | Account deletion | You → Privacy & safety → Delete account → Delete account → Keep my account → Delete account → Yes, delete my account | Consequences readable; "Keep my account" changes nothing; deletion lands on launch with the one-time line. Signing in again with the same number is refused until anonymization; other devices are signed out |
| 14 | Profile media | Home introduction, profile, You | Photos load from signed URLs; after 15 min in the background, reopening loads fresh URLs (no broken images) |
| 15 | Composer | Conversation: type, send, long message, Turkish characters (Ç ç Ğ ğ İ ı Ö ö Ş ş Ü ü), keyboard up/down | Composer stays above the keyboard; send works; no duplicate on retry; glyphs render correctly |
| 16 | Full journey | Phone → real SMS → Stage 1 → Received → (review-fixture: START_REVIEW, REQUEST_EXTENDED) → Extended → real photos → Final review → (APPROVE) → begin membership → (ACTIVATE) → Dating setup → profile confirmation → Home | Every transition renders from the server's lifecycle; no direct database edits |

## Results

| # | iPhone | Android |
|---|---|---|
| 1–16 | BLOCKED (no device, no staging build) | BLOCKED (no device, no staging build) |
