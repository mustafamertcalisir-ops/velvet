# DESIGN SYSTEM & VISUAL DIRECTION

## Design Goal

Create a premium mobile experience that feels:

- restrained
- photographic
- editorial
- intimate
- contemporary
- private
- culturally aware
- warm
- confident

The interface should not constantly announce that it is premium.

The quality should be visible in execution.

---

## Core Principle

CONTENT FIRST.
UI SECOND.

When a screen contains strong photography or video:
- content dominates
- UI sits quietly above it
- controls remain legible
- overlays use restraint

When a screen is form-based:
- typography and spacing create quality
- avoid unnecessary cards
- one question per screen where appropriate

---

## Visual References

Raya may be studied for:
- full-screen profile presentation
- small, quiet metadata
- dark overlays
- translucent control surfaces
- restrained navigation
- photography-led identity

Do not copy:
- exact layout
- exact buttons
- exact iconography
- exact typography
- exact colors
- exact animations
- exact profile structure

---

## Color Tokens

### Background / Dark

`color.obsidian`
#0B0B0C

`color.ink`
#151517

`color.surface.dark`
#1B1B1E

### Light

`color.pearl`
#F3F0EA

`color.paper`
#FAF8F4

### Neutral

`color.smoke`
#A8A6A2

`color.muted`
#77777D

### Signature

`color.pomegranate`
#7A3045

Use sparingly.

Potential uses:
- active states
- key membership moment
- selected interaction
- small brand accent

### Functional Micro-Accent

`color.bosphorus`
#55B9C8

Potential uses:
- system confirmation
- subtle selected indicator
- information accent

Do not let this become a bright cyan app.

---

## Contrast

All text and interactive surfaces must meet appropriate accessibility contrast.

Do not sacrifice readability for "luxury."

---

## Typography

Typography should carry much of the visual identity.

### Desired qualities
- editorial
- mature
- warm
- compact
- legible
- excellent numerals
- strong Turkish glyph support

### Suggested hierarchy

Display:
32–40px equivalent depending on platform/device.

Title:
24–30px.

Section title:
18–22px.

Body:
15–17px.

Supporting:
13–15px.

Micro:
11–13px only where readability remains strong.

Do not use tiny text merely to resemble a fashion magazine.

---

## Turkish Support

Every font must render:

Ç ç
Ğ ğ
İ ı
Ö ö
Ş ş
Ü ü

Test:
- names
- city names
- Turkish copy
- numerals
- punctuation

---

## Spacing

Use a consistent spacing system.

Suggested base:

4
8
12
16
20
24
32
40
48
64

Premium feel comes from rhythm, not random whitespace.

---

## Radius

Avoid excessive bubble UI.

Suggested use:

- small control radius: 10–12
- medium control: 14–16
- large sheet: 20–24
- full pill only when semantics justify it

Do not make every rectangular element a pill.

---

## Blur / Glass

Glass effects may be used over photography.

Rules:
- only when background context matters
- preserve contrast
- use subtle blur
- avoid frosted-glass overload
- do not put glass cards inside glass cards

---

## Shadows

Use minimally.

Dark mode:
- depth should often come from opacity and layering rather than dramatic shadow.

Light mode:
- very soft elevation only where necessary.

---

## Buttons

Primary button:
- visually confident
- full-width on form screens where appropriate
- clear enabled / disabled states
- excellent tap target

Secondary:
- visually quieter
- no fake hierarchy through excessive outlines

Text action:
- use for tertiary paths

Avoid:
- giant gradient CTA
- glossy effects
- 3D effects

---

## Form Screens

Most admission questions should be single-purpose screens.

Recommended structure:

1. Back / progress region
2. Question title
3. Short supporting copy if needed
4. Input or selection
5. Flexible spacer
6. Primary action near safe-area bottom

Do not add cards around simple inputs unless necessary.

---

## Application Status Screen

This screen must feel composed because applicants may see it repeatedly.

Use:
- calm title
- current status
- short explanation
- minimal status sequence
- application date
- notification expectation

Avoid:
- animation loops
- blinking indicators
- countdowns
- fake queue position

---

## Photography

Member profile photography should feel:
- personal
- editorial
- cinematic
- authentic
- not over-produced by default

Do not require conspicuous wealth imagery.

Do not visually reward:
- cars
- watches
- private jets
- bottle-service scenes

Photography should answer:
"Who is this person?"
not:
"What do they own?"

---

## Member Profiles

Future direction:

- full-screen / near-full-screen media
- small metadata
- short personal copy
- strong hierarchy
- few high-quality controls
- clear intent
- optional motion or music if product-approved

Avoid generic stacked cards.

---

## Navigation

Future member navigation should remain visually quiet.

Potential structure:
- Home
- Places
- Discover
- Messages
- You

Icon-only may be used if usability remains clear.

Do not imitate any reference app's exact icon set.

---

## Motion

Default motion qualities:
- 180–320ms for common transitions
- spring where physically appropriate
- no exaggerated bounce
- no "luxury = slow" assumption

Motion must not make basic workflows sluggish.

---

## Haptics

Use lightly for:
- successful verification
- clear selection
- meaningful completion
- match / important social event if later approved

Do not haptic every tap.

---

## Loading

Prefer:
- quiet progress
- skeletons where useful
- content-preserving transitions

Avoid:
- theatrical loaders
- spinning brand logos
- fake long review animation

---

## Error Design

Errors should be:
- human
- concise
- actionable

Bad:
"ERROR 403 OTP_INVALID"

Good:
"That code doesn't look right. Try again."

---

## Empty States

Use calm, useful language.

Do not shame the user.

---

## Design Review Checklist

For every screen ask:

1. What is the single primary action?
2. Is the hierarchy obvious?
3. Can anything be removed?
4. Does the copy sound human?
5. Does it feel premium because it is better, or because it is decorated?
6. Does it respect privacy?
7. Does it work on small devices?
8. Does it work with Turkish text?
9. Are touch targets comfortable?
10. Is motion necessary?
