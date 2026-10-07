# Screen reader and font-scaling QA report — VoiceOver, TalkBack, OS text size

**Status: BLOCKED.** No physical device was available. VoiceOver and
TalkBack cannot be exercised in a browser, and web rendering is **not** a
substitute (the brief forbids it).

**Nothing below has been heard through a real screen reader or seen at a
real OS text size.**

What exists today:
- **Code-level semantics** on the listed screens, reviewed in source and
  covered in part by component tests (e.g. `Button` exposes
  `accessibilityState.disabled`).
- **The delete-account screen added in this phase:**
  - the title is a header;
  - the confirmation's heading is a header and receives
    accessibility focus when it appears (`setAccessibilityFocus`, native);
  - errors render as `Notice` with `role="alert"` and are announced on
    native;
  - both actions are labelled buttons with ≥ 44 pt targets.

## Protocol (run on the staging build, both platforms)

For each screen, record:
- **Order:** the reading order; it should match the visual order.
- **Labels:** every control has a spoken name that says what it does, never
  "button" alone.
- **State:** selected, disabled and busy states are announced.
- **Announcements:** errors and outcomes are announced without moving focus
  unexpectedly.
- **Focus:** after navigation, focus lands on the screen title.
- **Actions:** swipe-to-next and double-tap reach everything; there are no
  focus traps.

| Screen | What to check specifically |
|---|---|
| Phone | Country code and number read as one field; the error ("Check the number") is announced; the continue button is announced as disabled until valid |
| OTP | Digit cells read as one code field (not six); autofill announced; wrong-code error and remaining attempts announced; resend announces its countdown/availability |
| A Stage 1 question (date of birth) | The question is a header; day/month/year order; validation message announced |
| Dating setup | Choice lists announce selected state; the age range announces both values and changes |
| Home | The introduction card reads name, age, city, occupation once; the photo has a label; Like / Pass are labelled and announce the outcome |
| Profile | Photos are labelled in sequence; "More options" is reachable |
| Like / Pass | The result is announced ("Liked" / "Passed"; a match is announced as a match, without hype) |
| Conversation | Messages read in order with sender; the composer is labelled; send is announced; a closed conversation states it |
| Delete account | Title, consequences and the retained-records sentence are read in order; "Delete account" moves focus to "Delete your account?"; "Yes, delete my account" / "Keep my account" are clear; errors are announced |

## Font scaling (OS text size)

| | iOS | Android |
|---|---|---|
| Settings to test | Larger Text: default, the largest standard size, and the largest Accessibility size | Font size: default, largest; Display size: largest |
| Screens | Phone, OTP, a Stage 1 question, Dating setup, Home, Profile, Like/Pass, Conversation, Delete account | same |
| Expected | Text grows; nothing is clipped or overlaps; buttons grow to fit their labels; long Turkish strings wrap; the primary action stays reachable (scroll); photographs never cover text | same |

## Results

| Screen | VoiceOver | TalkBack | iOS text size | Android font size |
|---|---|---|---|---|
| all listed | BLOCKED | BLOCKED | BLOCKED | BLOCKED |

**Critical issues found and fixed:** none could be found without devices.
The deletion screen was built with the semantics above.
