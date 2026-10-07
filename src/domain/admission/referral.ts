/**
 * Referral presentation (DEC-022, revised).
 *
 * The applicant types a referrer's full name and phone so the membership team
 * can reach them privately. Once added, the UI only ever shows a short form —
 * "Kerem A." — with a generic "Referral requested" state. The phone number is
 * never shown back, and nothing reveals whether that person is a member.
 */
export function referralDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (parts.length < 2) return first;
  const last = parts[parts.length - 1] ?? '';
  const initial = last.charAt(0).toLocaleUpperCase('tr-TR');
  return `${first} ${initial}.`;
}
