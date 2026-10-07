/**
 * Type system — two roles, clearly separated.
 *
 * EDITORIAL (Newsreader, serif): screen questions and major titles, the
 * Application Received moment, the status headline, and the Review read-back.
 * That is where the brand voice lives. Nowhere else.
 *
 * UI (Instrument Sans): everything the applicant operates or scans — typed
 * answers, labels, helper copy, validation, search, lists, metadata, status
 * details, buttons, progress.
 *
 * Both families verified for Ç ç Ğ ğ İ ı Ö ö Ş ş Ü ü (scripts/check-fonts.py).
 * Final family is a pending decision; swap here only.
 */
import {
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
  Newsreader_500Medium,
} from '@expo-google-fonts/newsreader';
import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
} from '@expo-google-fonts/instrument-sans';
import type { TextStyle } from 'react-native';

export const fontAssets = {
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
  Newsreader_500Medium,
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
};

export const font = {
  serif: 'Newsreader_400Regular',
  serifItalic: 'Newsreader_400Regular_Italic',
  serifMedium: 'Newsreader_500Medium',
  sans: 'InstrumentSans_400Regular',
  sansMedium: 'InstrumentSans_500Medium',
  sansSemiBold: 'InstrumentSans_600SemiBold',
} as const;

/** DESIGN.md hierarchy: display 32–40, title 24–30, section 18–22, body 15–17, supporting 13–15. */
export const type = {
  // Editorial ---------------------------------------------------------------
  display: { fontFamily: font.serif, fontSize: 38, lineHeight: 44, letterSpacing: -0.5 },
  headline: { fontFamily: font.serif, fontSize: 30, lineHeight: 36, letterSpacing: -0.3 },
  readback: { fontFamily: font.serif, fontSize: 21, lineHeight: 31, letterSpacing: -0.1 },
  wordmark: { fontFamily: font.serifItalic, fontSize: 20, lineHeight: 24, letterSpacing: 0.2 },

  // UI ---------------------------------------------------------------------------
  /** Typed answers: large enough to read back at a glance, but plainly a field. */
  answer: { fontFamily: font.sans, fontSize: 24, lineHeight: 30, letterSpacing: -0.2 },
  /** An answer that IS the screen (occupation): large, plainly typed, no box. */
  heroAnswer: { fontFamily: font.sansMedium, fontSize: 32, lineHeight: 40, letterSpacing: -0.5 },
  /** Written answers: comfortable reading size while typing — not editorial serif. */
  writing: { fontFamily: font.sans, fontSize: 19, lineHeight: 28 },
  title: { fontFamily: font.sansMedium, fontSize: 20, lineHeight: 26, letterSpacing: -0.1 },
  bodyLarge: { fontFamily: font.sans, fontSize: 17, lineHeight: 25 },
  body: { fontFamily: font.sans, fontSize: 16, lineHeight: 23 },
  supporting: { fontFamily: font.sans, fontSize: 15, lineHeight: 21 },
  label: { fontFamily: font.sansMedium, fontSize: 14, lineHeight: 19 },
  caption: { fontFamily: font.sans, fontSize: 13, lineHeight: 18 },
  button: { fontFamily: font.sansSemiBold, fontSize: 16, lineHeight: 20 },
  link: { fontFamily: font.sansMedium, fontSize: 15, lineHeight: 20 },
  numeral: { fontFamily: font.sansMedium, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
} as const satisfies Record<string, TextStyle>;

/** Large display text may scale with Dynamic Type, but within reason. */
export const maxFontScale = {
  display: 1.3,
  body: 1.8,
} as const;
