# Privacy boundaries

What each party can see, where the boundary is enforced, and how it is
tested. Decisions: DEC-005, DEC-018, DEC-040, DEC-049, DEC-055, DEC-058,
DEC-063, DEC-064, DEC-066, DEC-067, DEC-069. Retention of each data family:
docs/DATA_RETENTION.md. Endpoint-level policy: docs/SECURITY_MODEL.md.

---

## 1. Principles

1. **The server decides what leaves.** Every response is an explicit DTO
   built field by field; database rows are never passed through, and the
   UI is never relied on to hide a field.
2. **Members never touch the database.** The API is the only client; the
   `app` schema is closed to every other role, with row-level security
   enabled on every table and no policies (defence in depth).
3. **Private by default.** Application data, Dating settings, safety records
   and review data are private; a narrow, whitelisted projection becomes the
   public profile at activation.
4. **No inference.** Nothing about a person's identity is derived from their
   name, photographs, Instagram or content.

## 2. Who sees what

| Data | Applicant (self) | Member (self) | Other members | Membership team | Stored in |
|---|---|---|---|---|---|
| Phone number | own (account) | own | **never** | yes | `accounts` |
| Last name | own, on the application | — | **never** | yes | `application_private_data` |
| Date of birth | entered once; then derived age only | age | age only (derived in SQL) | yes | `application_private_data` |
| Instagram | own | — | **never** | yes | `application_private_data` |
| Referral names / numbers | short name only | — | **never** | yes | `application_referrals` |
| Written answers ("about you") | own, on request | — | **never** | yes | `application_private_data` |
| Work description | own | as "known for" (editable) | "known for" | yes | private → `member_profiles.known_for` |
| Application photos | own (signed URL, 10 min) | — | only as promoted member photos | yes (signed, logged) | `application_media` + private bucket |
| Verification photos | **never returned** — "received" only | — | **never** | reviewers only: `review:media`, 2-min url, every access logged | `application_media` + a SEPARATE private bucket |
| Dating answers on the application | own | — | **never** | matching only | `application_dating_preferences` |
| Dating identity & preferences | — | own (`/member/me/dating`) | **never** | matching only | `dating_settings` |
| Self-description words | — | own | **never**, never classified | not used for matching | `dating_settings.self_description` |
| Review actions, reasons, notes | status only | — | **never** | yes | `application_reviews`, `audit_events` |
| Account id | own session | own session | **never** (member ids only) | yes | — |
| Location | city label | city label | city label only; no coordinates | city | `member_profiles.city_label` |
| Blocks | — | own list | **never** (the blocked member is not told) | yes | `blocks` |
| Reports | — | — | **never** (the reported member is not told) | yes | `reports` |
| Messages | — | own conversations | the other participant only | on report | `messages` |
| Session tokens | own device only | own device only | **never** | **never** (only SHA-256 hashes are stored) | `sessions.token_hash` |
| One-time codes | the SMS only | — | **never** | **never** (HMAC only; never logged) | `otp_challenges.code_hash` |

## 3. The public member DTO

```ts
type PublicMemberDTO = {
  memberId; displayName; age; occupation; cityLabel; knownFor; interests; intents;
  photos: { id; uri /* signed, expiring */; width; height }[];
};
```

- Built by `toPublicMemberDTO` (server/src/member/dto.ts) from
  `PUBLIC_MEMBER_SELECT`, which selects public columns and computes `age` in
  SQL — the date of birth is not in the row.
- The shared type carries compile-time guards (`_NoPrivateFieldsOnMemberView`,
  `_MemberViewWhitelistIsComplete`).
- Tests: exact key sets (`server/test/privacy.test.ts`), a row deliberately
  carrying private columns still serialises to the whitelist, and every
  member response in a full flow is searched for surname, DOB, phone,
  Instagram, referral, application answers, Dating identity/categories,
  self-description words, account ids, coordinates, reviewer data and
  unsigned storage keys.

## 4. Dating data (DEC-058)

- Asked after activation, only of Dating members; never inferred.
- Used only by the server's eligibility function; the client receives only
  eligible members and never anyone's settings but its own.
- Not on the profile, preview, application summary, introduction card,
  match moment or messages.

## 5. Media (DEC-063, docs/MEDIA_ARCHITECTURE.md)

- Uploaded directly to private object storage with a short-lived signed
  url; identified by content and re-encoded on completion: EXIF, GPS and all
  metadata removed (tested by inspecting stored bytes, locally and on an
  S3-compatible store).
- Private buckets, opaque keys; no permanent public URLs. An object url
  without a valid signature is refused.
- Signed delivery URLs expire (member 15 min, application 10 min, reviewer
  access to verification 2 min) and are minted only for callers allowed to
  see the item at that moment. Bucket, key and expiry are signed, so a url
  cannot be bent to another object or class (tested).
- Verification photos live in their own bucket, are never returned by any
  applicant or member endpoint (not even to their owner), never promoted,
  and every reviewer access is written to the append-only media access log.

## 6. Safety records

- Blocks are silent and total: the match ends, the conversation closes, both
  disappear from each other's introductions, profiles and messages; every
  "unavailable" answer is the same, so blocks cannot be detected and members
  cannot be enumerated.
- Blocks, reports and messages are protected from ordinary deletion by
  database triggers; only the retention process can delete them, under a
  configured policy window and never while a retention hold applies
  (DEC-067). Audit events and the media access log are append-only. Hiding
  something in the UI never deletes evidence.
- After an account is anonymized, retained safety records point only at
  opaque ids; wherever another member could see the deleted member's name
  (their blocked list), it reads "Former member".

## 6a. Accounts, sessions and logs

- A deletion request signs the account out everywhere and removes the member
  from every other member's surfaces at once; anonymization later removes
  identity and private data (DEC-066, DEC-067). Members request it in the app
  (You → Privacy & safety → Delete account, DEC-077); the screen says what is
  removed and that "some records may be retained where needed for safety,
  security or legal obligations", and claims nothing beyond the policy.
- Signing out revokes the server session as well as clearing the device.
- The staging QA flag (`qa_account`, DEC-076) is internal: never in any
  applicant or member response (tested).
- Responses never reveal whether a phone number has an account.
- Logs carry request ids and safe facts only: never codes, tokens, full
  phone numbers, dates of birth, signed or verification urls, Dating
  settings, reviewer notes or request bodies (DEC-069; redaction tested).

## 7. On the device

- The app stores only its admission state (session token, status, own
  summary). Other members' profiles, introductions and messages stay in
  memory (DEC-055) and are dropped on sign-out.
- Release builds contain no mock server, fixtures, development hooks or
  fixed codes (release gate).

## 8. Screenshots

The product cannot prevent screenshots or external recording and never
claims to. Mitigations (platform screen-capture flags, discreet previews)
are a later phase.
