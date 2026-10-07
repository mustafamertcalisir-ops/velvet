import { referralDisplayName } from '../admission/referral';

describe('referral display (DEC-022)', () => {
  it.each([
    ['Kerem Aksoy', 'Kerem A.'],
    ['  Kerem   Aksoy  ', 'Kerem A.'],
    ['Ayşe Nur İnce', 'Ayşe İ.'],
    ['Elif ışık', 'Elif I.'],
    ['Şebnem Karaosmanoğlu-Büyükçekmeceli', 'Şebnem K.'],
    ['Cher', 'Cher'],
  ])('%p → %p', (name, shown) => expect(referralDisplayName(name)).toBe(shown));
});
