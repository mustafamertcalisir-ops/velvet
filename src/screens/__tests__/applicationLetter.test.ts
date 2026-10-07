import { copy } from '@/copy/en';
import { EMPTY_DRAFT, type ApplicationDraft } from '@/domain/admission/stage1';
import { composeLetter } from '../applicationLetter';

const draft: ApplicationDraft = {
  ...EMPTY_DRAFT,
  introAcknowledged: true,
  firstName: 'Şebnem',
  lastName: 'Karaosmanoğlu-Büyükçekmeceli',
  dateOfBirth: '1994-03-14',
  instagram: { kind: 'handle', handle: 'sebnem.k' },
  countryCode: 'TR',
  city: { kind: 'listed', cityId: 'TR-mugla', label: 'Muğla', region: null },
  referral: { kind: 'requested', referrals: [{ id: 'r', name: 'Kerem Aksoy', phoneE164: '+905551112233' }] },
};

const text = (d: ApplicationDraft) =>
  composeLetter(d, copy.review.readback)
    .map((p) => p.segments.map((s) => s.text).join('') + (p.privateNote ? ` [${p.privateNote}]` : ''))
    .join('\n');

describe('review read-back', () => {
  it('reads back Turkish names and places exactly', () => {
    const t = text(draft);
    expect(t).toContain('My name is Şebnem Karaosmanoğlu-Büyükçekmeceli.');
    expect(t).toContain('Born 14 March 1994. Based in Muğla, Türkiye.');
    expect(t).toContain('On Instagram as @sebnem.k.');
  });

  it('shows a referral as a short name, never the full name or number, and no double full stop', () => {
    const t = text(draft);
    expect(t).toContain('Referral requested from Kerem A.');
    expect(t).not.toContain('Kerem A..');
    expect(t).not.toContain('Aksoy');
    expect(t).not.toContain('555');
  });

  it('marks private paragraphs', () => {
    const paragraphs = composeLetter(draft, copy.review.readback);
    expect(paragraphs.find((p) => p.id === 'name')?.privateNote).toBe(copy.review.readback.notes.lastName);
    expect(paragraphs.find((p) => p.id === 'born')?.privateNote).toBe(copy.review.readback.notes.dob);
  });

  it('reads naturally without a referral', () => {
    expect(text({ ...draft, referral: { kind: 'none' } })).toContain('Applying without a referral.');
  });
});
