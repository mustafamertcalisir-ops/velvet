# Phase 5–7 (first slice) — Member vertical slice — report

Pass date: 5 October 2026. This pass builds the first complete member
experience, from approval through to a conversation:

Approved → Membership → activation → Member welcome → Profile confirmation
→ Home (today's introductions) → Profile → Pass / Like → mutual match →
Match moment → Conversation, plus Messages, You, Edit profile, Membership and
Privacy & safety.

Not built: Places, Travel, Directory, Events, professional networking,
recommendations, boosts, paid messages, read receipts, voice or media chat,
a real payment provider, a production reviewer dashboard, moderation tooling.

## What was preserved

The admission lifecycle, guards, reviewer and billing fixtures, outcome
screens and audit events are unchanged. `homeRoute` still sends
ACTIVE_MEMBER to `/member`. That route is now the member entrance: the
welcome until the profile is confirmed, and Home after that. The
`/member` guard (`canAccessMemberProduct`) still wraps every member route.
All 181 earlier unit tests and 427 earlier E2E checks pass unchanged.

## Member domain (src/domain/member/)

Kept apart from MembershipApplication (DATA_MODEL §9b):

- `views.ts`:
  - `MemberProfileView`, `MemberCard` and `OwnMemberProfile`, built as explicit projections.
  - A whitelist (`MEMBER_VIEW_FIELDS`) with compile-time checks against private keys.
  - `MemberProfilePatch`, the fields a member can edit.
- `introductions.ts`:
  - `IntroductionBatch`, a configurable `IntroductionPolicy` (6 per day, 30-day pass cooldown), `isCompatible`, `selectIntroductions` and `remainingIntroductions`.
- `matching.ts`:
  - `ReactionType` (`PASS` | `LIKE`), `MemberReaction`, and `Match` with a unique `pairKey`.
  - `decideReaction` is the single rule for every reaction.
- `conversation.ts`:
  - `Conversation` and `Message`.
  - Validation: 1–2000 characters, normalised.
  - `canSendMessage`, plus grouping by day and sender run, with "Today" / "Yesterday" labels and 24-hour times.
- `safety.ts`: `Block`, `Report`, and the six structured report reasons.
- `profileEdit.ts`: edits are validated with the same rules the application used.

`PublicMemberProfile` gained `knownFor`, `intents` and `confirmedAt`. Its
sanctioned constructor reads them from the approved application.
`MemberProfileMedia` records which application photo each image was promoted from.

## Server (mock)

- **API:** `src/services/api/memberTypes.ts` (`MemberApi`), implemented by `src/services/mock/mockMemberApi.ts`. It shares one transactional mock database with the admission server.
- **Access:** every call requires ACTIVE_MEMBER with a live membership.
- **Uniform refusal:** an unknown member, a blocked member, someone never introduced, or a non-participant all get the same `not_allowed`.
- **Activation:** the profile is provisioned from the approved application, and current profile photos are promoted. Verification photos never are.
- **Introductions:** the batch is chosen once per day and never refilled.
- **Matches:** created only when the like is mutual. Duplicates are impossible.
- **Conversations:** a conversation opens only for an active match. Sends are idempotent.
- **Block:** ends the match, closes the conversation and notifies no one.
- **Reports:** recorded with `status: open`.

## Client

- **State:** `src/state/member/*` holds member data in memory only (DEC-055). The provider exists only inside the `/member` guard.
- **Access loss:** losing access re-reads the lifecycle; a lost session signs out.
- **Screens** live in `src/app/member/` (see SCREEN_MAP M-01…M-11).
- **Components:**
  - `MemberTabBar`: text tabs, with a single Pomegranate "new" mark.
  - `SafetySheet`: report, then optional block; or block on its own.
  - `Photo` and `Controls`: drawn chevron and dots, no icon font.
- **Reused:**
  - The existing `ProfileView`, for confirmation, own profile and member profiles.
  - `ScreenShell`, `TextField`, `WritingField`, `InterestCurator`, `Sheet` and `ActionSheet`.

## Copy

All new copy lives in `copy.member`. Main lines:

- Welcome and confirmation: "You’re in." and "Enter the community".
- Home: "Today’s introductions", "More to come today" / "The last one today", and "That’s everyone for today."
- Pass and like outcomes:
  - "Passed. Elif won’t be shown to you again today."
  - "Liked. If Mert likes you too, you can start a conversation."
- Match: "You should meet." and "You and Deniz both said yes."
- Empty conversation: "You met through the community."

## Fixtures (development and test only)

- **Data:** `src/dev/communityFixture.ts` holds ten members in İstanbul, İzmir, Bodrum, Ankara, Berlin, Paris and London. It is loaded only through a build-time conditional require, so release bundles never contain it; the release gate checks for its markers.
- **Admirer:** Deniz already likes the test member, so liking back creates a real match.
- **Photographs:** `e2e/fixtures/members/` (Unsplash; sources in the README there). The harness serves them at `/__qa/members/`; they are not bundled.

## Tests

- **Jest:** 223 tests (181 earlier + 42 new) in 18 suites:
  - `src/state/__tests__/memberSlice.test.ts` (28) covers:
    - access: approved-but-unpaid, payment required, waitlisted, not admitted, final review, active;
    - profile: provisioning, private fields absent, edits limited to the public profile;
    - introductions: finite, no duplicates, never self, blocked never shown, passes leave the batch;
    - likes, matches and the fixture;
    - messaging: matched-only, text, idempotency, validation, blocks in both directions;
    - privacy across every member response;
    - client memory-only state.
  - `src/domain/__tests__/memberDomain.test.ts` (14) covers the pure rules.
- **E2E:** 570 checks.
  - 427 earlier checks, unchanged.
  - 15 new access checks in `e2e/outcomes.mjs`: `/member/home`, `/member/messages` and `/member/profile/me` stay closed before activation, while waitlisted and when not admitted.
  - 128 member-slice checks in `e2e/member.mjs` across 375, 393 and 430.
  - The 375 run uses reduced motion and also covers "Keep exploring".
  - The 430 run also blocks a match from the conversation.

## Visual QA

Every screen was rendered in Chromium (web build) at 375×667, 393×852 and
430×932, then inspected:

- welcome and confirmation (first frame and scrolled);
- home, profile (first media, scrolled, column);
- pass and like states, match moment;
- empty conversation and conversation with messages, messages list;
- you, edit profile (before and after a change);
- privacy & safety, membership;
- safety sheet, report reasons, block confirmation.

Issues found and fixed during this pass:

- The Home dateline had low contrast on light photographs.
- The like and pass outcome panel covered the profile's identity lines. It became a one-row panel.
- The composer was two rows high on web.
- Animations stalled at partial opacity when the reduced-motion preference resolved after mounting. They now snap to the final state.
- The match animation was skipped because its value was set before loading finished.
- The decision bar had low contrast on bright photographs.

Other checks:

- **Release gate:** the production web bundle contains no community fixture (new markers include `seedCommunity`, `velvet-community-fixture`, `usr_fx_` and `__qa/`). The QA bundle fails the same gate, which confirms the markers detect the fixture.
- **QA photography:** hashes of all 36 QA images were compared with all 40 images in the QA web, production web and native exports. None matched.
- **Native bundles:** iOS and Android export. These local exports are not production builds, so they contain the dev fixtures, as before. EAS release builds set `EXPO_PUBLIC_APP_ENV=production`.
- **Tooling:** `expo-doctor` passes 21/21, and the font glyph check passes.

Contact sheets:

- `docs/screenshots/member-vertical-slice-standard.jpg`
- `docs/screenshots/member-profile-widths.jpg`

## Known limitations

- **Web as proxy:** web stands in for native. Not checked on device: haptics (a no-op on web), the iOS keyboard on the composer, VoiceOver and Dynamic Type, blur on Android, and native stack transitions.
- **Matching:**
  - The product does not ask a member's own gender, so "who you’d like to meet" cannot be honoured yet (DEC-052).
  - Selection is shared intent plus a private age range, with curated order. There is no recommendation model.
- **Messages:** no real-time delivery. New messages appear when a conversation or Messages is opened again, and the unread mark refreshes on focus.
- **Not built:**
  - unblocking, undoing a pass, report follow-up, and moderation tooling;
  - billing management; Membership shows facts only.
- **Photos:**
  - City edits are a typed label, validated but not from the city catalogue.
  - Edited photo orders are saved; photos removed from a profile are kept server-side with order −1.
  - Photo moderation for member uploads is not implemented.
- **Mock server:** it runs on the device, so production isolation between members, encryption and rate limits are out of scope until a real backend exists.
- **Fixture photography:** the people pictured are stock models, not the fixture characters.

## Next logical step

Member product hardening before widening it:

1. A product decision on matching identity (DEC-052).
2. A real member backend with the same `MemberApi`.
3. Message delivery (polling, then push).
4. A moderation queue for reports.
5. Device QA for keyboard, haptics and screen readers.

Places, Travel and Directory come after that.
