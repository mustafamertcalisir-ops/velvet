# SCREEN MAP

Screen IDs are stable references for design, code, QA, and discussion.

---

# AUTHENTICATION

## AUTH-01 — Launch
Purpose:
Brand entry and routing based on account/application state.

## AUTH-02 — Phone Number
Purpose:
Collect international phone number.

## AUTH-03 — OTP Verification
Purpose:
Verify account ownership.

---

# INITIAL APPLICATION

## APP-00 — Application Intro
Purpose:
Explain membership review briefly.

## APP-01 — First Name
Input:
First name.

## APP-02 — Last Name
Input:
Last name.

## APP-03 — Date of Birth
Input:
DOB.

Rules:
18+.

## APP-04 — Instagram
Input:
Instagram handle / connection method.

## APP-05 — Country
Input:
Search/select country.

## APP-06 — City
Input:
Search/select city.

## APP-07 — Referral
Input:
Existing member referral if available.

Actions:
- Add referral
- Skip / I don't have a referral

## APP-08 — Application Review
Purpose:
Review Stage 1 fields.

Actions:
- Edit sections
- Submit Application

## APP-09 — Submission Confirmation
Purpose:
Optional lightweight final confirmation before irreversible submit.

## APP-10 — Application Received
Purpose:
Confirm successful receipt.

---

# APPLICATION STATUS

## STATUS-01 — Application Received
State:
APPLICATION_RECEIVED

## STATUS-02 — Under Review
State:
UNDER_REVIEW

## STATUS-03 — Continue Application
State:
EXTENDED_APPLICATION_REQUIRED

## STATUS-04 — Final Review
State:
FINAL_REVIEW

## STATUS-05 — More Information Required
State:
MORE_INFORMATION_REQUIRED

## STATUS-06 — Waitlisted
State:
WAITLISTED

## STATUS-07 — Approved
State:
APPROVED

## STATUS-08 — Not Admitted
State:
NOT_ADMITTED

---

# EXTENDED APPLICATION

## EXT-00 — Extended Application Intro
Purpose:
Explain why more information is requested.

## EXT-01 — Photos
Purpose:
Collect profile media.

## EXT-02 — Occupation
Purpose:
Short occupation label.

## EXT-03 — Work Context
Purpose:
Company / studio / institution / independent context.

## EXT-04 — What You Do
Purpose:
Short meaningful description of work, craft, or pursuit.

## EXT-05 — About You
Purpose:
Personal short response beyond CV information.

## EXT-06 — Interests
Purpose:
Select curated interests.

## EXT-07 — Intent
Purpose:
Why the applicant wants to join.

## EXT-08 — Dating Preferences
Purpose:
Only when Dating is selected.

## EXT-09 — Education
Purpose:
Optional.

## EXT-10 — Portfolio / Website
Purpose:
Optional supporting evidence.

## EXT-11 — Additional Verification
Purpose:
Conditional.

## EXT-12 — Profile Preview
Purpose:
Preview the possible future member profile.

## EXT-13 — Extended Review
Purpose:
Review Stage 2 answers.

## EXT-14 — Extended Submission Success
Purpose:
Confirm transition to final review.

---

# MEMBERSHIP ACTIVATION

## MEMBER-00 — Approved ("Welcome.")
State: APPROVED · Route: /application/status

## MEMBER-01 — Membership (one plan)
State: MEMBERSHIP_PAYMENT_REQUIRED · Route: /membership

## MEMBER-02 — Activation
Development billing fixture only; release builds show activation as not yet open.

---

# MEMBER PRODUCT — first vertical slice (built)

Every route below requires ACTIVE_MEMBER with a live membership.

## M-01 — Member welcome — /member
"You’re in." over the member's own first photograph. Shown until the
profile is confirmed (server record); afterwards /member opens Home.

## M-01b — Dating setup — /member/dating-setup (members using Dating only)
After the welcome, before confirmation (DEC-058). Step 1 "How do you
describe yourself?" — Woman · Man · Non-binary · Self-describe (private
words + "Include me when people are looking to meet"). Step 2 "Who would you
like to meet?" — Women · Men · Non-binary people · Everyone, and the age
range, pre-filled from the application. Private; never on any profile.
`?mode=edit` re-opens both steps from Dating preferences (no progress folio).

## M-02 — Profile confirmation — /member/confirm
The profile made at activation, exactly as members see it. Edit profile, or
"Enter the community".

## M-03 — Home: today's introductions — /member/home
One Dating introduction at a time, full-bleed. Opens the profile. No count.
End states: "That’s everyone for today." / "No introductions today."
Members not using Dating (Friendship / Community only): "Dating introductions
aren’t part of your experience right now." / "You joined for friendship and
community. More community experiences will come later." (DEC-050).
Dating setup not finished: one line and "Continue" to Dating setup.

## M-04 — Member profile — /member/profile/[id]
Lead frame + editorial column. Pass / Like only for today's introductions.
"More options": report, block. /member/profile/me shows your own profile.

## M-05 — Match moment — /member/match/[id]
"You should meet." Their photo and yours. Send a message / Keep exploring.

## M-06 — Messages — /member/messages
Active matches, most recent first; a small mark for something new.

## M-07 — Conversation — /member/conversation/[matchId]
Text only. Day and time grouping. Profile access, report, block.

## M-08 — You — /member/you
Own profile; Edit profile; Dating preferences (Dating members); Membership;
Privacy & safety; Sign out.

## M-08b — Dating preferences — /member/dating-preferences
The member's own private Dating settings (you, included under when
self-described, who you'd like to meet, ages) and "Change". Changes apply
to future introductions; matches and conversations stay.

## M-09 — Edit profile — /member/edit-profile
Photos (order, add, remove; 3–6), occupation, city, known for, interests.

## M-10 — Membership — /member/membership
Plan, status, member since, renews.

## M-11 — Privacy & safety — /member/privacy
What members see / never see, location, blocked members, reporting; Your
account → Delete account.

## M-12 — Delete account — /member/delete-account (DEC-077)
Consequences in plain words (profile leaves the community, signed out on every
device, matches and conversations end, membership ends, personal details and
photos then deleted, cannot be undone) and the retained-records sentence →
"Delete account" → confirmation "Delete your account?" with "Yes, delete my
account" / "Keep my account" → on success the launch screen with a one-time
line "Your account has been deleted and you’ve been signed out." Failure:
nothing changes, retry.

---

# FUTURE MEMBER PRODUCT (not built)

PEOPLE-01 broader discovery · DIRECTORY-01 · PLACES-01 · TRAVEL-01 ·
events · advanced recommendations · media in chat.

---

# ROUTING RULES

Routing should be based on authoritative account/application state.

Examples:

UNAUTHENTICATED
→ AUTH-02

PHONE_VERIFICATION
→ AUTH-03

APPLICATION_DRAFT
→ last incomplete APP screen

APPLICATION_RECEIVED
→ STATUS-01

UNDER_REVIEW
→ STATUS-02

EXTENDED_APPLICATION_REQUIRED
→ STATUS-03

EXTENDED_APPLICATION_DRAFT
→ last incomplete EXT screen

FINAL_REVIEW
→ STATUS-04

WAITLISTED
→ STATUS-06

APPROVED
→ MEMBER-00 / membership activation

MEMBERSHIP_PAYMENT_REQUIRED
→ MEMBER-01 (/membership)

ACTIVE_MEMBER
→ M-01 (/member): welcome until the profile is confirmed, then Home
