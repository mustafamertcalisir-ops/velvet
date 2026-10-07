# ADMISSION FLOW — SOURCE OF TRUTH

This document is the canonical product flow for membership admission.

If implementation conflicts with this document, update the decision explicitly rather than silently changing behavior.

---

# 1. Lifecycle Overview

```text
UNAUTHENTICATED
    ↓
PHONE_VERIFICATION
    ↓
APPLICATION_DRAFT
    ↓
APPLICATION_SUBMITTED
    ↓
APPLICATION_RECEIVED
    ↓
UNDER_REVIEW
    ↓
EXTENDED_APPLICATION_REQUIRED
    ↓
EXTENDED_APPLICATION_DRAFT
    ↓
EXTENDED_APPLICATION_SUBMITTED
    ↓
FINAL_REVIEW
    ↓
┌───────────────────────────────┐
│ APPROVED                      │
│ WAITLISTED                    │
│ MORE_INFORMATION_REQUIRED     │
│ NOT_ADMITTED                  │
└───────────────────────────────┘
```

After approval:

```text
APPROVED
    ↓
MEMBERSHIP_PAYMENT_REQUIRED
    ↓
ACTIVE_MEMBER
```

---

# 2. Phone Verification

## Screen
Phone Number

Input:
- country calling code
- phone number

Requirements:
- international format support
- phone formatting
- validation
- rate limiting
- resend safeguards

After valid submission:
PHONE_VERIFICATION remains active until OTP succeeds.

## OTP

Input:
- 6-digit code or implementation-defined OTP length
- auto focus
- paste support
- accessible input behavior

On success:
→ APPLICATION_DRAFT

---

# 3. Application Introduction

Purpose:
Explain that membership requires review.

Recommended message direction:

Apply for membership.

Membership is considered individually. Tell us a little about yourself.

Avoid promising acceptance.

---

# 4. Stage 1 Fields

Exact intended order:

## APP-01 First Name
Required.

## APP-02 Last Name
Required.
Private by default.

## APP-03 Date of Birth
Required.
Must resolve to age 18+.

## APP-04 Instagram
Required for current product concept unless product decision changes.
Store as application information.
Do not automatically publish.

## APP-05 Country
Required.

## APP-06 City
Required.

## APP-07 Referral
Optional.

Support:
- existing-member lookup if technically available
- invite/referral request
- skip/no referral

Referral may have states:
- none
- selected
- requested
- confirmed
- unavailable

Referral does not guarantee acceptance.

---

# 5. Application Review

Display a summary before submission.

Show:
- first name
- last name
- DOB or age representation appropriate for review
- Instagram
- country
- city
- referral status

Allow editing.

Primary action:
Submit Application

---

# 6. Submission

On submit:

APPLICATION_DRAFT
→ APPLICATION_SUBMITTED

After successful server acknowledgement:

APPLICATION_SUBMITTED
→ APPLICATION_RECEIVED

Do not transition directly to approval.

---

# 7. Application Received

Applicant sees:

Status:
Application received

Supporting behavior:
- show date submitted
- explain that every application is reviewed
- inform applicant that status updates will appear here
- push/email notification may be used later

Do not show:
- decision estimate unless real and product-approved
- queue number
- acceptance percentage

---

# 8. Under Review

State:
UNDER_REVIEW

Purpose:
Show that the application is actively being considered.

Suggested message:

Your application is under review.

Review times vary for each application.

Avoid:
- countdown
- urgency
- false progress

---

# 9. Extended Application Required

State:
EXTENDED_APPLICATION_REQUIRED

Entry message:

We'd like to know you better.

Complete the next part of your application to continue the review process.

Primary action:
Continue Application

---

# 10. Stage 2 — Extended Application

When started:

EXTENDED_APPLICATION_REQUIRED
→ EXTENDED_APPLICATION_DRAFT

Recommended fields:

## EXT-01 Photos
Minimum target: 3
Maximum target: 6
Exact limits may change by decision.

## EXT-02 Occupation
Short public-friendly label.

## EXT-03 Work Context
Company, studio, institution, independent, etc.
Optional unless decision changes.

## EXT-04 What You Do
Short description of work / craft / pursuit.

## EXT-05 Personal Prompt
"What should we know about you?"
or a similarly refined prompt.

## EXT-06 Interests
Curated multi-select.
Avoid hundreds of meaningless tags.

## EXT-07 Intent
Potential options:
- Dating
- Friendship
- Community

Exact product taxonomy may evolve.

## EXT-08 Dating Preferences
Only when relevant to intent: asked only when Dating is chosen (DEC-040).
Who you'd like to meet (Women / Men / Everyone) and an age range. Private.

## EXT-09 Optional Education
Never turn admission into a diploma ranking.

## EXT-10 Optional Portfolio / Website
Useful for creatives and specialists.

## EXT-11 Additional Verification
Only when needed.

## EXT-12 Profile Preview
Preview only.
Not yet visible to members.

---

# 11. Extended Submission

On completion:

EXTENDED_APPLICATION_DRAFT
→ EXTENDED_APPLICATION_SUBMITTED

After accepted by backend:

EXTENDED_APPLICATION_SUBMITTED
→ FINAL_REVIEW

---

# 12. Final Review

State:
FINAL_REVIEW

Suggested message:

Your completed application is in final review.

Do not imply approval.

---

# 13. More Information Required

State:
MORE_INFORMATION_REQUIRED

This must be specific.

Examples:
- replace unclear photo
- verify identity
- correct Instagram handle
- confirm DOB
- provide missing application answer

After completion, return to the appropriate review state.

---

# 14. Waitlist

State:
WAITLISTED

Meaning:
Application remains active but membership is not currently offered.

Avoid:
- gamified queue number
- implying the user can buy acceptance
- fake daily progress

Potential future behavior:
- application remains eligible for reconsideration
- applicant may update limited information if policy allows

---

# 15. Approved

State:
APPROVED

Suggested message:
Welcome.

Then:
→ MEMBERSHIP_PAYMENT_REQUIRED

Only after membership activation:
→ ACTIVE_MEMBER

---

# 16. Not Admitted

State:
NOT_ADMITTED

Suggested message direction:

We're unable to offer membership at this time.

Avoid:
- "Rejected"
- humiliating language
- scoring
- detailed social ranking

Reapplication policy should be defined separately.

---

# 16b. Review outcomes — as implemented (Phase 4)

See DECISIONS DEC-040 … DEC-047.

```
APPLICATION_RECEIVED ──start review──▶ UNDER_REVIEW
UNDER_REVIEW ──request extended──▶ EXTENDED_APPLICATION_REQUIRED ─▶ … ─▶ FINAL_REVIEW
UNDER_REVIEW | FINAL_REVIEW ──request information──▶ MORE_INFORMATION_REQUIRED
MORE_INFORMATION_REQUIRED ──applicant sends update──▶ (the stage that asked)
UNDER_REVIEW | FINAL_REVIEW ──waitlist──▶ WAITLISTED ──reopen──▶ UNDER_REVIEW | FINAL_REVIEW
FINAL_REVIEW ──approve──▶ APPROVED ──applicant: Continue──▶ MEMBERSHIP_PAYMENT_REQUIRED
MEMBERSHIP_PAYMENT_REQUIRED ──billing confirms to server──▶ ACTIVE_MEMBER
UNDER_REVIEW | FINAL_REVIEW | WAITLISTED ──not admit──▶ NOT_ADMITTED (terminal)
```

Information requests are structured (REPLACE_PHOTO, VERIFY_IDENTITY,
UPDATE_INSTAGRAM, CLARIFY_WORK, UPDATE_APPLICATION_FIELD). "Confirm DOB" is
covered by identity verification and not offered as a separate edit, so the
date of birth stays immutable after submission.

Photos (Stage 2, REPLACE_PHOTO, VERIFY_IDENTITY) are uploaded directly to
private storage through a short-lived signed upload and processed by the
server on completion (DEC-063, docs/MEDIA_ARCHITECTURE.md). An identity
photo answering VERIFY_IDENTITY is a separate media class, visible only to
reviewers: the applicant's request shows "Photo received. Only our
membership team can see it." (plus their own local copy right after taking
it), never an image from the server. The lifecycle states are unchanged.

Dating preferences (EXT-08) are two steps after intent, only when Dating is
chosen: who you'd like to meet, and an age range.

After activation (DEC-048, DEC-049): on MEMBERSHIP_ACTIVATED the server
provisions the member profile from the approved application. The member
lands on `/member` — the welcome ("You’re in."), then Profile confirmation
("Enter the community") — and only then Home. The admission lifecycle ends
at ACTIVE_MEMBER; the member product has its own records (DATA_MODEL §9b).

Account deletion (DEC-066) is outside the admission lifecycle: an applicant
or member may request deletion at any state; the account (not the
application status) moves to `deletion_requested` and later `anonymized`
(docs/DATA_RETENTION.md). Suspension is likewise an account state set by
safety tooling; the application's own SUSPENDED status is unchanged and
unused by this mechanism.

---

# 17. Persistence

Application state must survive:
- app close
- app restart
- login from the same verified account
- normal network interruption

Draft field persistence should exist where technically appropriate.

---

# 18. Authorization Guards

Applicants must not access member-only routes.

Guard by authoritative membership state.

Do not rely only on hidden UI.

Backend authorization must enforce member-only access in production.

---

# 19. Test Scenarios

At minimum test:

1. Valid adult completes Stage 1.
2. Under-18 DOB is rejected.
3. Invalid OTP.
4. Expired OTP.
5. Referral skipped.
6. Referral selected.
7. Draft restored after restart.
8. Submitted application cannot be edited except where policy allows.
9. APPLICATION_RECEIVED cannot enter member area.
10. UNDER_REVIEW cannot enter member area.
11. EXTENDED_APPLICATION_REQUIRED can begin Stage 2.
12. Stage 2 draft restores.
13. FINAL_REVIEW cannot enter member area.
14. APPROVED must complete membership activation.
15. ACTIVE_MEMBER can enter member app.
16. ACTIVE_MEMBER sees the welcome and profile confirmation before Home.
17. Every member route (not only /member) stays closed before activation.
