# Dating compatibility

How the product decides who may be introduced to whom for Dating — and what
it never does. Decisions: DEC-058 (changes DEC-050, supersedes DEC-052 for
Dating), DEC-060 (match lifecycle, revised 2026-10-06).

Scope: Dating only. Today's Introductions is Dating-only in V1; Friendship
and Community are valid intents with a future discovery surface of their own
that will not use these rules (DEC-050, DEC-052).

---

## 1. When the question is asked

Only after membership is activated, and only of members who chose Dating
among their intents on the extended application:

```
MEMBERSHIP ACTIVATED → MEMBER WELCOME → DATING SETUP (if Dating) → PROFILE CONFIRMATION → ENTER COMMUNITY
```

- Not in the initial application, not in the extended application.
- Friendship / community-only members are never asked and are not part of
  Dating introductions; their Home says "Dating introductions aren’t part of
  your experience right now. More community experiences will come later."
  (no date promised).
- Until setup is complete, a Dating member gets no introductions and is
  introduced to no one (`DATING_SETUP_REQUIRED`). Home offers one line and
  "Continue".

## 2. The member's own identity

"How do you describe yourself?"

| Answer | Stored `gender` | Included under (`appearsAs`) |
|---|---|---|
| Woman | `WOMAN` | `[WOMAN]` (derived) |
| Man | `MAN` | `[MAN]` (derived) |
| Non-binary | `NON_BINARY` | `[NON_BINARY]` (derived) |
| Self-describe | `SELF_DESCRIBED` + private words (≤ 40 chars) | chosen by the member — one or more of Women / Men / Non-binary people ("Include me when people are looking to meet") |

```ts
type DatingGenderId = 'WOMAN' | 'MAN' | 'NON_BINARY' | 'SELF_DESCRIBED';
type DatingGenderPreference = 'WOMAN' | 'MAN' | 'NON_BINARY';
type DatingIdentity = { gender: DatingGenderId; selfDescription: string | null; appearsAs: DatingGenderPreference[] };
```

Rules:

- Stated by the member. Never inferred from a name, photographs, Instagram,
  reviewer judgement, AI or any content.
- Self-described words are never read, classified or interpreted — matching
  uses only the categories the member chose.
- A fixed answer cannot claim other categories (the server derives them).

## 3. Who the member would like to meet

"Who would you like to meet?" — Women · Men · Non-binary people · Everyone.
Stored as normalised categories; **Everyone = all three selected**.
Pre-filled from the extended application's answer (`women`, `men`,
`non_binary`, `everyone` → categories), with the age range; the member
confirms or changes both.

```ts
type DatingSettings = {
  identity: DatingIdentity | null;
  seeking: DatingGenderPreference[];
  ageRange: { min: number; max: number } | null;   // 18–80, max > min
  setupCompletedAt: string | null;
};
```

## 4. The one eligibility function

`datingEligibility(viewer, candidate, pair)` in
`src/domain/member/compatibility.ts` — used by the mock server and the
production API alike, when generating a day's batch, when re-checking an
introduction that is still waiting, and when a reaction arrives. Screens
never evaluate compatibility.

Rules, in order (the first failure is the reason):

| # | Rule | Reason code |
|---|---|---|
| 1 | Viewer is an active member | `VIEWER_INACTIVE` |
| 2 | Candidate is an active member | `CANDIDATE_INACTIVE` |
| 3 | Not the same member | `SELF` |
| 4 | Candidate's profile is visible | `HIDDEN` |
| 5 | No block, either direction | `BLOCKED` |
| 6 | Not exhausted from the cycle (§5) | `EXHAUSTED` |
| 7 | Both use Dating | `VIEWER_/CANDIDATE_NOT_USING_DATING` |
| 8 | Both completed Dating setup | `VIEWER_/CANDIDATE_SETUP_INCOMPLETE` |
| 9 | Viewer seeks a category the candidate appears under | `VIEWER_DOES_NOT_SEEK_CANDIDATE` |
| 10 | Candidate seeks a category the viewer appears under | `CANDIDATE_DOES_NOT_SEEK_VIEWER` |
| 11 | Candidate's age is inside the viewer's range | `CANDIDATE_OUTSIDE_VIEWER_AGE_RANGE` |
| 12 | Viewer's age is inside the candidate's range | `VIEWER_OUTSIDE_CANDIDATE_AGE_RANGE` |
| 13 | No safety hold on either (hook for future safety rules) | `SAFETY` |

Reasons are internal (tests, diagnostics). They are never shown to members.

Worked examples (all in the test matrix):

| Viewer | Candidate | Result |
|---|---|---|
| Woman → Men | Man → Women | introduced both ways |
| Man → Women | Man → Women | never |
| Woman → Women | Man → Women | one-sided: never |
| Woman → Men, Non-binary | Non-binary → Everyone | both ways |
| Man → Women | Non-binary → Everyone | never (he does not seek non-binary people) |
| Woman → Everyone | Man → Men | never |
| Self-described, included under Women | Man → Women | both ways, if he is sought |
| Self-described, included under Non-binary | Man → Women | never — the words are irrelevant |
| Ages 32, range 28–40 | 45 | never |
| 32 | 35, his range 33–40 | never (she is outside his range) |

## 5. The introduction cycle (exhaustion)

`exhaustedCandidates` removes, for the viewer:

- anyone already **liked** — ever;
- anyone **passed** within 30 days (`passCooldownDays`);
- anyone with an **ACTIVE** or **BLOCKED** match with the viewer;
- anyone with an **ENDED** match — never reintroduced under the current
  policy (`rematchAfterDays: null`). If a rematch window is ever set, the
  pair is eligible again after it, and only likes made after the match ended
  count toward a new match (a fresh start);
- anyone **introduced on an earlier day** within 14 days (`reintroduceAfterDays`).

A day's batch: at most 6 (`perDay`), chosen once per member per calendar
day (Europe/Istanbul on the server), never refilled, ordered by the
server's curation rank (a stable daily order until curation exists).

At most one ACTIVE match per pair exists at a time — enforced by a partial
unique index; a block sets the match BLOCKED; ended matches are kept as
history (DEC-060). An active block in either direction makes an
introduction, and so a match, impossible.

Performance (measured on 20,000 synthetic members, BACKEND_ARCHITECTURE.md
§5): the mutual category and age-range conditions also run in SQL as a
prefilter (`POOL_PREFILTER`), so only plausible candidates leave the
database; `datingEligibility` still decides every one.

## 6. Introductions as records

- `IntroductionEntry` — one introduction (viewer, candidate, day, position,
  context `DATING`, status `PENDING | PASSED | LIKED | WITHDRAWN`) — is the
  unit a reaction answers: `POST /introductions/{introductionId}/reaction`.
- Waiting entries are re-checked whenever they are read: anyone no longer
  eligible (a block, a lapsed membership, changed preferences on either
  side) is **withdrawn**. A stale tap on a withdrawn introduction is refused
  (`NOT_ELIGIBLE`); yesterday's introduction is `INTRODUCTION_EXPIRED`.
- The client never receives an incompatible profile and never filters
  anything locally.

## 7. Changing preferences

"Dating preferences" (You) shows the member's own settings and "Change"
(the same two steps, without the onboarding folio). Saving:

- applies to introductions from now on (waiting ones are re-checked at once);
- never deletes matches, conversations or messages;
- is rate-limited (30 per hour).

## 8. Privacy

Dating identity and preferences are private matching data:

- never on the member's profile, the confirmation preview, the application
  summary, an introduction card, the match moment, Messages or any other
  member's response;
- readable by the member themselves (`GET /member/me/dating`) and the
  server's eligibility function only;
- covered by serialization and end-to-end tests that search every member
  response for identity, category and self-description strings.

## 9. Tests

- `src/domain/__tests__/datingCompatibility.test.ts` — the full matrix (29 cases).
- `src/state/__tests__/memberSlice.test.ts` — setup required, non-Dating,
  identity and self-description flows, preference edits, privacy (mock server).
- `server/test/member.test.ts` — the same rules on PostgreSQL through the API,
  plus the match lifecycle (one ACTIVE per pair under real concurrency,
  history, no reintroduction of ended pairs, rematch fresh start).
- `server/test/queryplan.test.ts` — measured plans of the generation queries.
- `e2e/member.mjs` — self-described (small) and Woman (standard) setups,
  edit, non-Dating Home (large).

## 10. Not decided yet

- The taxonomy beyond these four answers and three categories.
- Friendship / Community discovery (a separate future surface, not these rules).
- Whether ended pairs may ever be reintroduced (`rematchAfterDays`) and an unmatch feature.
- Curation beyond the stable daily order.
