/**
 * Placeholder photography (Unsplash, graded with scripts/grade-photography.py).
 * To be replaced with commissioned work — DEC-028. One module so the swap is trivial.
 */
export const photography = {
  launch: require('../../assets/photography/launch-graded.jpg'),
  /** Shared by Application Received (full-bleed) and Application Status (band) for continuity. */
  application: require('../../assets/photography/bosphorus-graded.jpg'),
  /**
   * Approval returns to the photograph from the very first screen — the only
   * change of atmosphere in the admission flow, and a quiet one (DEC-046).
   */
  welcome: require('../../assets/photography/launch-graded.jpg'),
} as const;

export const photographyA11y = {
  launch: 'A ferry deck on the Bosphorus in morning mist',
  application: 'The Bosphorus under a cloudy sky',
  welcome: 'A ferry deck on the Bosphorus in morning mist',
} as const;
