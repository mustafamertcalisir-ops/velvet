import { buildProfilePreview, intentLine, intentPhrase, joinNatural } from '../profile/profilePresentation';

const photo = (id: string) => ({ id, uri: `file:///${id}.jpg`, width: 1080, height: 1440, moderationStatus: 'pending' as const });

describe('profile presentation', () => {
  it('has an intent phrase for labelled contexts', () => {
    expect(intentPhrase(['community', 'dating'])).toBe('dating and community');
    expect(intentPhrase([])).toBeNull();
  });

  it('writes intent as one sentence', () => {
    expect(intentLine(['community', 'friendship'])).toBe('Here for friendship and community');
    expect(intentLine(['dating'])).toBe('Here for dating');
    expect(intentLine(['dating', 'friendship', 'community'])).toBe('Here for dating, friendship and community');
    expect(intentLine([])).toBeNull();
  });

  it('joins interests naturally', () => {
    expect(joinNatural(['Architecture', 'Swimming', 'Jazz'])).toBe('Architecture, Swimming and Jazz');
    expect(joinNatural(['Jazz'])).toBe('Jazz');
  });

  it('builds the preview only from whitelisted fields', () => {
    const p = buildProfilePreview({
      summary: { firstName: 'Çağla', age: 32, cityLabel: 'Muğla' },
      fallbackFirstName: 'ignored',
      fallbackCity: 'ignored',
      extended: {
        photos: [photo('a'), photo('b')],
        occupation: 'Architect',
        whatYouDo: 'Restoring wooden houses.',
        interests: ['Architecture', 'Jazz', 'Swimming'],
        intents: ['friendship'],
      },
    });
    expect(Object.keys(p).sort()).toEqual(
      ['age', 'cityLabel', 'firstName', 'intentLine', 'interestsLine', 'knownFor', 'media', 'occupation'].sort(),
    );
    expect(p.media.map((m) => m.kind)).toEqual(['photo', 'photo']);
    expect(p.firstName).toBe('Çağla');
  });
});
