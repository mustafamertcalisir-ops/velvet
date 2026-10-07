/**
 * Validation for member profile edits — the same rules the application used
 * for the same fields, applied to the member profile only.
 */
import {
  PHOTO_MAX,
  PHOTO_MIN,
  WHAT_YOU_DO_MAX,
  validateInterests,
  validateLongText,
  validateShortText,
} from '../admission/stage2';
import { validatePlaceName } from '../validation/name';
import type { MemberProfilePatch } from './views';

export type EditableField = keyof MemberProfilePatch;

export type NormalizedPatch = {
  occupation?: string;
  cityLabel?: string;
  knownFor?: string;
  interests?: string[];
  photoOrder?: string[];
};

export function validateMemberProfilePatch(
  patch: MemberProfilePatch,
  ctx: { photoIds: readonly string[] },
): { ok: true; value: NormalizedPatch } | { ok: false; fields: EditableField[] } {
  const bad: EditableField[] = [];
  const out: NormalizedPatch = {};
  // Only known keys are read; anything else in the payload is ignored.
  if (patch.occupation !== undefined) {
    const v = validateShortText(patch.occupation);
    if (v.ok) out.occupation = v.value;
    else bad.push('occupation');
  }
  if (patch.cityLabel !== undefined) {
    const v = validatePlaceName(patch.cityLabel);
    if (v.ok) out.cityLabel = v.value;
    else bad.push('cityLabel');
  }
  if (patch.knownFor !== undefined) {
    const v = validateLongText(patch.knownFor, WHAT_YOU_DO_MAX);
    if (v.ok) out.knownFor = v.value;
    else bad.push('knownFor');
  }
  if (patch.interests !== undefined) {
    const v = validateInterests(patch.interests);
    if (v.ok) out.interests = v.value;
    else bad.push('interests');
  }
  if (patch.photoOrder !== undefined) {
    const ids = patch.photoOrder;
    const unique = new Set(ids);
    if (
      unique.size !== ids.length ||
      ids.length < PHOTO_MIN ||
      ids.length > PHOTO_MAX ||
      ids.some((id) => !ctx.photoIds.includes(id))
    ) {
      bad.push('photoOrder');
    } else {
      out.photoOrder = [...ids];
    }
  }
  return bad.length ? { ok: false, fields: bad } : { ok: true, value: out };
}
