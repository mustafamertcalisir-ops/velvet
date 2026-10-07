# Design analysis

Updated in the Phase 1 alignment pass (3 Oct 2026) against PRODUCT.md,
DESIGN.md, ADMISSION_FLOW.md, SCREEN_MAP.md and raya-notes.md.

**Reference screenshots have still not been supplied.** The principles below
come from the written references and the alignment brief. Revisit this when
the screenshots arrive.

## Principles taken from the reference category

| Principle | Why it works | How we apply it |
|---|---|---|
| Photography dominates | People and places carry the emotion; UI ages faster than images | Launch, Received, Final-review and Status lead with a graded photograph; the profile preview is image-first |
| Small metadata | Profiles are not résumés | Preview shows name/age large, occupation and city small |
| Quiet controls on dark, translucent surfaces | Controls stay available without becoming the subject | Back chevron + numeral folio + 2pt progress; sheets over a blurred backdrop only for pickers/confirmation |
| Restrained navigation | Focus stays on the one task | One question per screen; one primary action |
| Neutral dark foundation | Photography supplies colour | Obsidian/Ink/Pearl; accent only for current stage, validation, selection |
| Exclusivity through mechanics | Visual luxury reads as insecurity | The application itself is the signal; no badges, gold, VIP language |

## What is ours (original)

- **The read-back.** Stage 1 Review reads the answers back as short sentences
  in the editorial serif ("My name is Çağla Öztürk-Işıl. Born 14 March 1994.
  Based in Muğla, Türkiye."), each answer an underlined, tappable edit, with a
  plain sans note under any sentence that contains private details.
- **Receipt → home.** Application Received is a full-bleed, graded photograph;
  Application Status reuses the same photograph condensed into a band, so the
  one-time moment visibly settles into the durable home. The same pattern
  repeats for the extended application ("Your application is in final review.").
- **The status home.** Headline, one line, a quiet stage sequence, and three
  plain facts — submitted, your next step, where updates appear. A primary
  action appears only when there is one.
- **Grade.** Placeholder photographs are graded consistently (partial
  desaturation, highlight roll-off so skies never fight text, warmth in the
  light areas, fine grain) — an intentional look instead of stock decoration.

## Balance

Roughly 60% contemporary digital product (UI sans, clear controls, clear
states), 25% editorial restraint (serif voice in a few places, generous
rhythm), 15% cinematic atmosphere (graded photography at the moments that
matter).

## Typography roles (DEC-032)

| Role | Family | Used for |
|---|---|---|
| Editorial | Newsreader 400 / italic | Questions and major titles (30), receipt/status headlines (38), Review read-back (21), wordmark |
| UI | Instrument Sans 400/500/600 | Typed answers (24, stepping to 21/18 for long values), body 16–17, supporting 15, labels 14, captions 13, buttons 16 semibold, numerals 13 tabular |

Both families verified for Ç ç Ğ ğ İ ı Ö ö Ş ş Ü ü. Tested with Çağla,
Öztürk-Işıl, Şebnem Karaosmanoğlu-Büyükçekmeceli, Gökçe, İstanbul, Muğla,
Kahramanmaraş, Alexandra-Charlotte Montgomery-Fitzwilliam Ainsworth and
Saint-Rémy-de-Provence.

## Tokens

| Token | Value | Contrast on Obsidian | Use |
|---|---|---|---|
| Obsidian | `#0B0B0C` | — | Ground |
| Ink | `#151517` | — | Long-answer fields, tiles |
| Surface dark | `#1B1B1E` | — | Sheets, secondary and disabled fills |
| Pearl | `#F3F0EA` | 17.3:1 | Text, primary action |
| Smoke | `#A8A6A2` | 8.1:1 | Secondary text |
| Tertiary | `#8C8A86` | 5.7:1 | Captions |
| Muted | `#77777D` | 4.4:1 | Non-text only (dashed frames, unchecked marks) |
| Pomegranate mark | `#C25A73` | 4.7:1 | Current review stage only |
| Validation | `#E39AAA` | 8.9:1 | Error text and rules |
| Bosphorus | `#55B9C8` | 8.6:1 | Selected state only |

Radii (DESIGN.md): controls 12, preview frame 16, sheets 24. No pills.
Motion: 120 / 220 / 320 ms, 6pt rise, everything instant under reduced motion.
Buttons: 54pt, Pearl primary; pressed darkens to `#E2DED6`; disabled is a
distinct dark fill with tertiary label; secondary is a quiet fill with no outline.

## Deliberately avoided

Gold, crowns, diamonds, VIP/elite language, pills, giant rounded cards,
decorative gradients, all-caps eyebrows, arrows on buttons, confetti,
countdowns, queue positions, probabilities, per-stage dates, story-style
progress ticks on the profile preview (first replaced with a quiet "1 / 3";
since DEC-034 the preview is scroll-only, so there is no index at all).
