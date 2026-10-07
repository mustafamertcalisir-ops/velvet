/**
 * Privacy boundaries: explicit DTOs, serialization whitelists, and the
 * database closed to every role except the API.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMBER_VIEW_FIELDS } from '@/domain/member/views';
import { toMemberCardDTO, toPublicMemberDTO, type PublicMemberRow } from '../src/member/dto';
import { activeMember, testServer, type T } from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer();
});
afterAll(async () => t.close());

describe('PublicMemberDTO serialization', () => {
  const row = {
    id: 'mem_1',
    display_name: 'Deniz',
    occupation: 'Architect',
    city_label: 'İstanbul',
    known_for: 'Libraries.',
    interests: ['Architecture'],
    intents: ['dating'],
    visibility: 'visible',
    confirmed_at: null,
    age: 34,
    // Columns that must never travel, even if a query selected them by mistake:
    account_id: 'usr_secret',
    last_name: 'Kaptanoğlu',
    date_of_birth: '1992-02-11',
    phone_e164: '+905000000003',
    instagram_handle: 'deniz.private',
    gender: 'MAN',
    seeking: ['WOMAN'],
    appears_as: ['MAN'],
    self_description: 'words',
    age_min: 27,
    age_max: 40,
    latitude: 41.0,
    longitude: 28.9,
    personal_response: 'private',
    reason_code: 'COMMUNITY_FIT',
  } as unknown as PublicMemberRow;
  const photos = [{ id: 'mmd_1', uri: 'https://api.test/v1/storage/object?b=media&k=member%2Fmem_1%2Fmmd_1.jpg&exp=1&sig=x', width: 10, height: 10 }];

  it('has exactly the whitelisted keys and nothing else', () => {
    const dto = toPublicMemberDTO(row, photos);
    expect(Object.keys(dto).sort()).toEqual([...MEMBER_VIEW_FIELDS].sort());
    expect(Object.keys(dto.photos[0]!).sort()).toEqual(['height', 'id', 'uri', 'width']);
    const json = JSON.stringify(dto);
    for (const secret of ['usr_secret', 'Kaptanoğlu', '1992-02-11', '+90500', 'deniz.private', 'MAN"', 'WOMAN', 'words', '"age_min"', '41', 'private', 'COMMUNITY_FIT', 'visible']) {
      expect(json).not.toContain(secret);
    }
  });

  it('cards carry only the card fields', () => {
    expect(Object.keys(toMemberCardDTO(row, photos)).sort()).toEqual(['age', 'cityLabel', 'displayName', 'memberId', 'occupation', 'photo']);
  });
});

describe('every member response, end to end', () => {
  it('never carries private application data, Dating settings, account ids, coordinates or raw storage keys', async () => {
    const w = await activeMember(t, {
      firstName: 'Selin',
      dating: { gender: 'SELF_DESCRIBED', selfDescription: 'PRIVATE-WORDS genderqueer', appearsAs: ['WOMAN'], seeking: ['MAN'], ageRange: { min: 25, max: 45 } },
    });
    const m = await activeMember(t, { firstName: 'Mert', dateOfBirth: '1992-02-11', dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 25, max: 45 } } });
    const mIntro = await t.request('GET', '/v1/introductions/today', { token: m.token });
    const wIntro = await t.request('GET', '/v1/introductions/today', { token: w.token });
    await t.request('POST', `/v1/introductions/${mIntro.body.waiting[0].introductionId}/reaction`, { token: m.token, body: { type: 'LIKE' } });
    const match = await t.request('POST', `/v1/introductions/${wIntro.body.waiting[0].introductionId}/reaction`, { token: w.token, body: { type: 'LIKE' } });
    const conv = await t.request('POST', `/v1/matches/${match.body.match.matchId}/conversation`, { token: m.token });
    const seenByHim = [
      mIntro.body,
      (await t.request('GET', `/v1/members/${w.memberId}`, { token: m.token })).body,
      (await t.request('GET', `/v1/matches/${match.body.match.matchId}`, { token: m.token })).body,
      (await t.request('GET', '/v1/conversations', { token: m.token })).body,
      conv.body,
    ];
    const json = JSON.stringify(seenByHim);
    for (const forbidden of [
      'Karaosmanoğlu', // surname
      '1994-03-14', // date of birth
      '+90532', // phone
      'sebnem.private', // Instagram
      'Gökçe', // referral
      'PRIVATE-ABOUT-YOU', // application answer
      'Atölye Kuzguncuk', // application work context
      'PRIVATE-WORDS', 'genderqueer', 'SELF_DESCRIBED', 'selfDescription', 'appearsAs', 'seeking', 'gender', 'ageRange', '"WOMAN"', '"MAN"',
      w.accountId, m.accountId, 'usr_',
      'latitude', 'longitude', 'coordinates',
      'reviewer', 'reason', 'COMMUNITY_FIT', 'audit',
    ]) {
      expect(json).not.toContain(forbidden);
    }
    // Media is only reachable through signed, expiring URLs.
    const uris = [...json.matchAll(/"uri":"([^"]+)"/g)].map((x) => x[1]!);
    expect(uris.length).toBeGreaterThan(0);
    for (const u of uris) expect(u).toMatch(/^https:\/\/api\.test\/v1\/storage\/object\?b=media&k=member%2F[^&]+&exp=\d+&sig=[A-Za-z0-9_-]+$/);
    // Her own settings are hers to read.
    expect((await t.request('GET', '/v1/member/me/dating', { token: w.token })).body.identity.selfDescription).toBe('PRIVATE-WORDS genderqueer');
  });

  it('applicant responses carry only the applicant’s own data', async () => {
    const m = await activeMember(t, { firstName: 'Ece' });
    const mine = await t.request('GET', '/v1/me/application', { token: m.token });
    expect(Object.keys(mine.body).sort()).toEqual(['application', 'informationRequests', 'membership', 'summary']);
    expect(JSON.stringify(mine.body)).not.toMatch(/reviewer|reason_code|CAPACITY|COMMUNITY_FIT|Karaosmanoğlu|1994-03-14|Gökçe/);
  });
});

describe('database access boundary', () => {
  it('row-level security is enabled on every table in the app schema', async () => {
    const { rows } = await t.pool.query(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThanOrEqual(25);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it('a non-API role can read nothing — not even after a mistaken grant', async () => {
    await activeMember(t, { firstName: 'Nil' });
    const role = `probe_${Math.random().toString(36).slice(2, 8)}`;
    await t.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe'`);
    const url = new URL(t.config.databaseUrl);
    url.username = role;
    url.password = 'probe';
    const probe = new pg.Client({ connectionString: url.toString() });
    await probe.connect();
    try {
      for (const table of ['application_private_data', 'accounts', 'dating_settings', 'application_reviews', 'audit_events', 'reports', 'messages']) {
        await expect(probe.query(`SELECT * FROM app.${table}`)).rejects.toThrow(/permission denied/);
      }
      // A grant slips in: row-level security still shows nothing.
      await t.admin.query(`GRANT USAGE ON SCHEMA app TO ${role}; GRANT SELECT ON app.application_private_data, app.dating_settings TO ${role}`);
      expect((await probe.query('SELECT * FROM app.application_private_data')).rows).toEqual([]);
      expect((await probe.query('SELECT * FROM app.dating_settings')).rows).toEqual([]);
    } finally {
      await probe.end();
    }
  });
});
