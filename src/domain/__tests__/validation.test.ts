import { citiesFor, cityDisplayLabel } from '../geo/cities';
import { searchCountries } from '../geo/countries';
import { foldForSearch, searchBy } from '../text/search';
import { ageOn, validateDateOfBirth, type CalendarDate } from '../validation/dateOfBirth';
import { normalizeInstagram } from '../validation/instagram';
import { validateName, validatePlaceName } from '../validation/name';
import { maskPhone, validatePhone } from '../validation/phone';

const TODAY: CalendarDate = { year: 2026, month: 10, day: 3 };
const dob = (day: number, month: number, year: number) =>
  validateDateOfBirth({ day: String(day), month: String(month), year: String(year) }, TODAY);

describe('names', () => {
  it.each(['Çağla', 'Gülşen', 'İlknur', 'Işıl', 'Öykü', 'Şükrü', 'Ümit', 'Ağaoğlu', "O'Neil", 'Ayşe-Nur', 'Mary Jane'])(
    'accepts %s',
    (n) => expect(validateName(n)).toEqual({ ok: true, value: n }),
  );

  it('trims and collapses whitespace without changing case', () => {
    expect(validateName('  İpek   Su  ')).toEqual({ ok: true, value: 'İpek Su' });
    expect(validateName('ıŞIK')).toEqual({ ok: true, value: 'ıŞIK' });
  });

  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['Ali2', 'invalid_characters'],
    ['-Ali', 'invalid_characters'],
    ["Ali'", 'invalid_characters'],
    ['Ali 🙂', 'invalid_characters'],
    ['a'.repeat(51), 'too_long'],
  ])('rejects %p as %s', (n, error) => expect(validateName(n)).toEqual({ ok: false, error }));

  it('validates free-text place names', () => {
    expect(validatePlaceName('Kaş').ok).toBe(true);
    expect(validatePlaceName("Côte d'Azur").ok).toBe(true);
    expect(validatePlaceName('1').ok).toBe(false);
  });
});

describe('date of birth', () => {
  it('accepts someone who turns 18 today', () => {
    expect(dob(3, 10, 2008).ok).toBe(true);
  });
  it('rejects someone who turns 18 tomorrow', () => {
    expect(dob(4, 10, 2008)).toEqual({ ok: false, error: 'under_minimum_age' });
  });
  it('rejects future dates', () => {
    expect(dob(1, 1, 2030)).toEqual({ ok: false, error: 'future_date' });
  });
  it('rejects impossible dates', () => {
    expect(dob(31, 2, 1990)).toEqual({ ok: false, error: 'impossible_date' });
    expect(dob(29, 2, 2001)).toEqual({ ok: false, error: 'impossible_date' });
    expect(dob(0, 5, 1990)).toEqual({ ok: false, error: 'impossible_date' });
    expect(dob(12, 13, 1990)).toEqual({ ok: false, error: 'impossible_date' });
  });
  it('accepts real leap days', () => {
    expect(dob(29, 2, 2000).ok).toBe(true);
  });
  it('rejects incomplete and implausible input', () => {
    expect(validateDateOfBirth({ day: '1', month: '', year: '1990' }, TODAY)).toEqual({ ok: false, error: 'incomplete' });
    expect(validateDateOfBirth({ day: '1', month: '1', year: '90' }, TODAY)).toEqual({ ok: false, error: 'incomplete' });
    expect(dob(1, 1, 1900)).toEqual({ ok: false, error: 'implausible_date' });
  });
  it('treats a 29 Feb birthday as reached on 1 March in non-leap years', () => {
    const leapling = { year: 2008, month: 2, day: 29 };
    expect(ageOn(leapling, { year: 2026, month: 2, day: 28 })).toBe(17);
    expect(ageOn(leapling, { year: 2026, month: 3, day: 1 })).toBe(18);
    expect(ageOn(leapling, { year: 2028, month: 2, day: 29 })).toBe(20);
  });
  it('uses calendar arithmetic, independent of timezone', () => {
    expect(ageOn({ year: 1990, month: 12, day: 31 }, { year: 2026, month: 12, day: 30 })).toBe(35);
    expect(ageOn({ year: 1990, month: 12, day: 31 }, { year: 2026, month: 12, day: 31 })).toBe(36);
  });
});

describe('instagram', () => {
  it.each([
    ['@Selin.Kaya', 'selin.kaya'],
    ['selin_kaya', 'selin_kaya'],
    ['instagram.com/selin.kaya', 'selin.kaya'],
    ['https://www.instagram.com/selin.kaya/?hl=tr', 'selin.kaya'],
    ['  @@selin  ', 'selin'],
  ])('normalises %p', (raw, handle) => expect(normalizeInstagram(raw)).toEqual({ ok: true, value: handle }));

  it.each([
    ['', 'required'],
    ['selin kaya', 'invalid_handle'],
    ['.selin', 'invalid_handle'],
    ['selin..kaya', 'invalid_handle'],
    ['şelin', 'invalid_handle'],
    ['a'.repeat(31), 'invalid_handle'],
    ['https://instagram.com/p/abc123', 'not_a_profile_link'],
    ['https://example.com/selin', 'not_a_profile_link'],
  ])('rejects %p', (raw, error) => expect(normalizeInstagram(raw)).toEqual({ ok: false, error }));
});

describe('phone', () => {
  it.each([
    ['532 123 45 67', 'TR', '+905321234567'],
    ['0532 123 45 67', 'TR', '+905321234567'],
    ['07400 123456', 'GB', '+447400123456'],
    ['(415) 555-2671', 'US', '+14155552671'],
    ['01512 3456789', 'DE', '+4915123456789'],
    ['+33 6 12 34 56 78', 'TR', '+33612345678'],
  ])('accepts %s (%s)', (national, cc, e164) => {
    const r = validatePhone(national, cc);
    expect(r.ok && r.value.e164).toBe(e164);
  });
  it('rejects invalid numbers', () => {
    expect(validatePhone('123', 'TR')).toEqual({ ok: false, error: 'invalid_number' });
    expect(validatePhone('', 'TR')).toEqual({ ok: false, error: 'required' });
  });
  it('masks third-party numbers', () => {
    expect(maskPhone('+905321234567')).toBe('+90 ••• 67');
  });
});

describe('search folding (Turkish-aware)', () => {
  it('folds dotted and dotless i and diacritics', () => {
    expect(foldForSearch('İstanbul')).toBe('istanbul');
    expect(foldForSearch('IĞDIR')).toBe('igdir');
    expect(foldForSearch('Şanlıurfa')).toBe('sanliurfa');
  });
  it('finds Turkish cities from ASCII queries', () => {
    const tr = citiesFor('TR');
    const names = (q: string) => searchBy(tr, q, (c) => [c.name]).map((c) => c.name);
    expect(names('istanbul')[0]).toBe('İstanbul');
    expect(names('izmir')[0]).toBe('İzmir');
    expect(names('sanli')[0]).toBe('Şanlıurfa');
    expect(names('ISTANBUL')[0]).toBe('İstanbul');
  });
  it('lists all 81 Turkish provinces', () => {
    expect(citiesFor('TR')).toHaveLength(81);
  });
  it('finds countries by Turkish name, code and calling code', () => {
    expect(searchCountries('Almanya')[0]?.code).toBe('DE');
    expect(searchCountries('turkiye')[0]?.code).toBe('TR');
    expect(searchCountries('+44')[0]?.code).toBe('GB');
  });
  it('disambiguates duplicate city names by region', () => {
    const us = citiesFor('US');
    const portlands = us.filter((c) => c.name === 'Portland').map((c) => cityDisplayLabel(c, us));
    expect(portlands).toEqual(['Portland, Oregon', 'Portland, Maine']);
    const ny = us.find((c) => c.name === 'New York');
    expect(ny && cityDisplayLabel(ny, us)).toBe('New York');
  });
});
