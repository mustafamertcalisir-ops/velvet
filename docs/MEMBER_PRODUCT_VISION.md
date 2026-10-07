# MEMBER PRODUCT VISION

This document describes the future product after approval.

It is intentionally secondary to admission work.

Do not use it as permission to skip ahead.

---

# 0. Where the member product stands (2026-10-05)

Built and approved: the first member slice — welcome, profile confirmation,
today's introductions, profile, pass/like, mutual match, text conversation,
Messages, You, edit profile, membership, privacy & safety, block and report
(DEC-048 – DEC-057).

Since then (DEC-058 – DEC-065):

- **Introductions are Dating introductions.** A Dating member states their
  own identity after activation (Woman · Man · Non-binary · Self-describe,
  with chosen categories) and who they would like to meet; introductions
  require reciprocal preferences and age ranges. Members not using Dating
  are not introduced yet — friendship and community discovery is a later
  phase, to be designed on its own terms rather than reusing Dating rules.
- **A production backend foundation exists** (Node/TypeScript API on
  PostgreSQL) that owns every decision the mock made; the mock remains for
  development and deterministic tests.

Production hardening (2026-10-06, DEC-060 revised, DEC-066 – DEC-072): at
most one ACTIVE match per pair with history (no unmatch UI yet); account
deletion and anonymization; data-retention semantics; direct photo uploads
with a reviewer-only class for identity photos; staging architecture. No new
member feature was added.

**Friendship and Community remain part of this product.** Today's
Introductions is Dating-only in V1 (DEC-050): members who joined only for
friendship or community are not introduced through it, and their Home says
so quietly ("Dating introductions aren’t part of your experience right now.
More community experiences will come later." — no date promised). Their
intents are stored and valid. **Friendship / Community discovery is a future
product surface** with its own model — it must not reuse Dating
compatibility — and Directory, Places, Gatherings and Travel below remain
the community vision it draws from.

Still not built (and not to be started without a decision): Places, Travel,
Directory, Gatherings/events, professional networking, recommendation
models, compatibility scores, boosts, paid pre-match messages, reviewer
dashboard, read receipts, voice, video chat.

---

# 1. Member Home

The home experience should not feel like an infinite commodity feed.

Potential model:
Curated daily introductions.

Goals:
- fewer, more intentional profiles
- encourage profile attention
- reduce swipe fatigue
- maintain quality perception

Do not finalize daily limits without product testing.

Built (DEC-050, DEC-058): a finite Dating batch per day (6, never shown as a
number), one person at a time, chosen by one server-side eligibility
function. The quantity remains provisional.

---

# 2. Member Profile

Desired qualities:
- media-led
- cinematic
- concise
- personal
- editorial

Potential content:
- first name
- age
- occupation
- city
- photos
- short video
- concise personal text
- interests
- selected prompts

Potential later experiment:
Music/audio identity.

Not yet a settled decision.

---

# 3. Discovery

Discovery should balance:
- relevance
- serendipity
- privacy
- community quality

Potential inputs:
- city
- age preferences
- intent
- interests
- profession/category
- mutual community context
- travel

Do not expose secret/internal admission signals.

Dating compatibility (built, DEC-058) uses only stated, private answers:
the member's own identity categories, who they would like to meet, and age
ranges — each side must fit the other. Never inferred from names, photos,
Instagram or content; self-described words are never classified.
Friendship and community introductions need their own model — a future
Friendship / Community discovery surface (DEC-050, DEC-052): shared intents
and interests, mutual community context and city may matter there; Dating
identity, Dating preferences and age-range reciprocity must not.

---

# 4. Interaction Model

Possible future interactions:
- pass
- like
- introduction request

An introduction request could allow a short thoughtful message before a mutual match.

This must be rate-limited and safety-reviewed.

Do not finalize monetization before the interaction design is clear.

---

# 5. Messages

Messaging begins only when product rules permit.

Requirements:
- block
- report
- safety entry points
- privacy-respecting notifications
- spam controls

Future ideas:
- read receipts
- voice notes
- media

None are mandatory until approved.

---

# 6. Directory

A member directory could support intentional discovery.

Potential filters:
- city
- profession
- interests
- community intent

Avoid:
- wealth filters
- follower filters
- visible admission score
- public referral count

---

# 7. Places

Purpose:
Connect community with real-world city life.

Potential examples:
- gallery opening
- restaurant
- cultural event
- members' gathering
- neighborhood presence

Privacy principle:
Presence should be approximate and opt-in.

Good:
"Members around Karaköy tonight."

Bad:
"Mert is currently inside this exact venue."

---

# 8. Travel

Members may share future city plans.

Potential fields:
- destination city
- date range
- visibility

Potential behavior:
Discover members who will be in the same city.

Travel should not expose hotel or exact accommodation.

---

# 9. Gatherings

Future curated experiences may include:
- dinner
- exhibition visit
- screening
- design/culture gathering
- small community event

Avoid:
- generic speed-dating branding
- nightclub promoter aesthetic
- forced networking games

The experience should feel like a thoughtful social invitation.

---

# 10. Privacy Modes

Future controls may include:
- profile pause
- hidden mode
- city visibility
- travel visibility
- Places opt-in
- contact blocking
- social-handle visibility

Built: Dating preferences (private; changes apply to future introductions
and never remove matches or conversations), blocked members list.

---

# 11. Membership

Membership is access to the community.

Do not frame it as:
"Pay more to become more valuable."

Potential plan structure should remain simple.

Avoid:
- Gold
- Platinum
- Diamond
- Elite

---

# 12. Product Tone

The member product should feel like:
"a beautiful private social space"

not:
"a gamified dating machine."
