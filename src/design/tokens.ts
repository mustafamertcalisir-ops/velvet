/**
 * Design tokens — aligned with DESIGN.md (colour names, spacing base, radii).
 * Contrast ratios are measured against Obsidian unless noted.
 * Photography carries the colour; these tokens are deliberately quiet.
 */
import { Platform } from 'react-native';

const palette = {
  obsidian: '#0B0B0C',
  ink: '#151517',
  /** DESIGN.md `color.surface.dark` — sheets, disabled and secondary fills. */
  surfaceDark: '#1B1B1E',
  pearl: '#F3F0EA',
  paper: '#FAF8F4',
  smoke: '#A8A6A2',
  /** DESIGN.md `color.muted` — 4.4:1, so NON-TEXT ONLY (dividers, disabled glyph strokes). */
  muted: '#77777D',
  /** Signature. 2.2:1 on Obsidian — never as text or a thin mark on dark. */
  pomegranate: '#7A3045',
  /** Pomegranate lifted for marks on dark (4.7:1): current review stage, focus of a selection. */
  pomegranateMark: '#C25A73',
  /** Pomegranate lifted for validation text (8.9:1; 7.8:1 on surfaceDark). */
  pomegranateText: '#E39AAA',
  /** Functional micro-accent (8.6:1). Currently unused: selection is shown in Pearl (DEC-039). */
  bosphorus: '#55B9C8',
} as const;

export const color = {
  ...palette,
  background: palette.obsidian,
  surface: palette.ink,
  surfaceRaised: palette.surfaceDark,
  text: palette.pearl,
  /** 8.1:1 */
  textSecondary: palette.smoke,
  /** 5.7:1 (5.0:1 on surfaceDark) — the lowest-contrast readable text. */
  textTertiary: '#8C8A86',
  hairline: 'rgba(243, 240, 234, 0.12)',
  hairlineStrong: 'rgba(243, 240, 234, 0.28)',
  focus: palette.pearl,
  caret: palette.pearl,
  selection: 'rgba(243, 240, 234, 0.28)',
  error: palette.pomegranateText,
  /** Accent use is limited to: the current review stage and validation. */
  stageMark: palette.pomegranateMark,
  /**
   * Selection is shown with Pearl (title steps forward, short rule, drawn
   * tick), not colour — DEC-039. Bosphorus stays in the palette, unused.
   */
  selected: palette.pearl,
  primaryPressed: '#E2DED6',
  scrim: 'rgba(11, 11, 12, 0.55)',
  onPrimary: palette.obsidian,
} as const;

export const opacity = {
  disabled: 0.4,
  pressed: 0.72,
  muted: 0.56,
} as const;

/** DESIGN.md spacing base: 4 8 12 16 20 24 32 40 48 64. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
} as const;

export const layout = {
  gutter: 24,
  /** Readable measure on large phones / tablets. */
  maxContentWidth: 520,
  minTouchTarget: 44,
  buttonHeight: 54,
  headerHeight: 52,
} as const;

/** DESIGN.md: small control 10–12, medium 14–16, sheet 20–24. No pills. */
export const radius = {
  none: 0,
  control: 12,
  field: 12,
  medium: 16,
  sheet: 24,
} as const;

export const blur = {
  surface: 30,
  sheet: 40,
} as const;

export const elevation = {
  sheet: Platform.select({
    ios: { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: -6 } },
    android: { elevation: 12 },
    default: {},
  }),
} as const;

/**
 * DESIGN.md: 180–320ms for common transitions; no "luxury = slow".
 * Reduced motion collapses everything to an instant change.
 */
export const motion = {
  instant: 0,
  quick: 120,
  standard: 220,
  considered: 320,
  rise: 6, // px of vertical travel on enter
  pressScale: 0.985,
} as const;
