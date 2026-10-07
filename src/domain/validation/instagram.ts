import { invalid, valid, type Validation } from './result';

export type InstagramError = 'required' | 'invalid_handle' | 'not_a_profile_link';

const HANDLE = /^[a-z0-9._]{1,30}$/;
const RESERVED_PATHS = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'tv']);

/**
 * Accepts "@name", "name", "instagram.com/name", "https://www.instagram.com/name/?hl=tr".
 * Returns the normalised lower-case handle without "@".
 */
export function normalizeInstagram(raw: string): Validation<string, InstagramError> {
  let value = raw.trim();
  if (!value) return invalid('required');

  const looksLikeUrl = /instagram\.com|instagr\.am|^https?:\/\//i.test(value);
  if (looksLikeUrl) {
    const m = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/([^/?#]+)/i.exec(value);
    if (!m || !m[1]) return invalid('not_a_profile_link');
    if (RESERVED_PATHS.has(m[1].toLowerCase())) return invalid('not_a_profile_link');
    value = m[1];
  }

  value = value.replace(/^@+/, '').toLowerCase();
  if (!HANDLE.test(value)) return invalid('invalid_handle');
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    return invalid('invalid_handle');
  }
  return valid(value);
}
