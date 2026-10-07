/**
 * Composes the Review screen's read-back: the applicant's answers as a few
 * short sentences, each answer an editable segment. Paragraphs that contain
 * private information carry a plain note saying who can see it.
 */
import { referralDisplayName } from '@/domain/admission/referral';
import type { ApplicationDraft, Stage1Step } from '@/domain/admission/stage1';
import { countryByCode } from '@/domain/geo/countries';
import { parseISODate } from '@/domain/validation/dateOfBirth';

export type LetterSegment = { text: string } | { text: string; edit: Stage1Step; label: string };
export type LetterParagraph = { id: string; segments: LetterSegment[]; privateNote?: string };

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatLongDate(iso: string): string {
  const d = parseISODate(iso);
  return d ? `${d.day} ${MONTHS[d.month - 1]} ${d.year}` : iso;
}

export type LetterCopy = {
  name: string;
  born: string;
  based: string;
  instagram: string;
  referral: string;
  noReferral: string;
  and: string;
  notes: { lastName: string; dob: string; instagram: string; referral: string };
};

export function composeLetter(draft: ApplicationDraft, c: LetterCopy): LetterParagraph[] {
  const country = countryByCode(draft.countryCode)?.name ?? '';
  const referrals = draft.referral?.kind === 'requested' ? draft.referral.referrals : [];

  return [
    {
      id: 'name',
      segments: [
        { text: c.name },
        { text: draft.firstName ?? '', edit: 'first-name', label: 'First name' },
        { text: ' ' },
        { text: draft.lastName ?? '', edit: 'last-name', label: 'Last name' },
        { text: '.' },
      ],
      privateNote: c.notes.lastName,
    },
    {
      id: 'born',
      segments: [
        { text: c.born },
        {
          text: draft.dateOfBirth ? formatLongDate(draft.dateOfBirth) : '',
          edit: 'date-of-birth',
          label: 'Date of birth',
        },
        { text: '. ' + c.based },
        { text: draft.city?.label ?? '', edit: 'city', label: 'City' },
        ...(country
          ? ([{ text: ', ' }, { text: country, edit: 'country', label: 'Country' }] as LetterSegment[])
          : []),
        { text: '.' },
      ],
      privateNote: c.notes.dob,
    },
    {
      id: 'instagram',
      segments: [
        { text: c.instagram },
        {
          text: draft.instagram?.kind === 'handle' ? `@${draft.instagram.handle}` : '',
          edit: 'instagram',
          label: 'Instagram',
        },
        { text: '.' },
      ],
      privateNote: c.notes.instagram,
    },
    {
      id: 'referral',
      segments:
        referrals.length > 0
          ? [
              { text: c.referral },
              {
                text: referrals.map((r) => referralDisplayName(r.name)).join(c.and),
                edit: 'referral',
                label: 'Referral',
              },
              ...(referralDisplayName(referrals[referrals.length - 1]?.name ?? '').endsWith('.')
                ? []
                : [{ text: '.' }]),
            ]
          : [{ text: c.noReferral, edit: 'referral', label: 'Referral' }, { text: '.' }],
      privateNote: referrals.length > 0 ? c.notes.referral : undefined,
    },
  ];
}
