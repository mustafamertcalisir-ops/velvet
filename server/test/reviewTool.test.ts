/**
 * The owner's review tool (scripts/review.ts → dist/velvet-review.mjs), run
 * against the real HTTP stack in-process with scripted terminal answers:
 * setup, the queue, an application, photos, decisions (with and without
 * confirmation), information requests, the invited membership, the
 * interactive loop and the plain-language errors. Also: what it keeps on
 * disk (settings 0600; the last list as ids only).
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkApi, run, safeLink, type IO } from '../scripts/review';
import { applicantInFinalReview, INTERNAL_KEYS, review, seedPlan, signIn, stage1, testServer, type T } from './harness';

const API = 'http://127.0.0.1:9';
let t: T;
let dir: string;
let env: NodeJS.ProcessEnv;
const fetchImpl = (url: string, init: RequestInit) => t.app.request(url.slice(API.length), init);

beforeAll(async () => {
  t = await testServer(undefined, { SMS_TEST_NUMBERS: '+90555000*' });
  await seedPlan(t);
  dir = mkdtempSync(join(tmpdir(), 'velvet-review-'));
  env = { VELVET_REVIEW_CONFIG: join(dir, 'settings.json') };
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await t.close();
});

function io(answers: string[] = []) {
  const out: string[] = [];
  const opened: string[] = [];
  const queue = [...answers];
  const next = async (q: string) => {
    out.push(q);
    if (!queue.length) throw new Error(`unexpected question: ${q}`);
    return queue.shift()!;
  };
  const value: IO = {
    print: (s) => void out.push(s),
    ask: next,
    askHidden: next,
    open: async (u) => (opened.push(u), true),
    now: () => t.clock.now(),
  };
  return { io: value, out: () => out.join('\n'), opened, left: () => queue.length };
}
const tool = async (argv: string[], answers: string[] = []) => {
  const s = io(answers);
  const code = await run(argv, s.io, env, { fetch: fetchImpl as never, signingEnv: 'test' });
  return { code, out: s.out(), opened: s.opened, left: s.left() };
};
const listIds = () => (JSON.parse(readFileSync(`${env.VELVET_REVIEW_CONFIG}.list`, 'utf8')) as { ids: string[] }).ids;
const status = async (id: string) => (await t.admin.query('SELECT status FROM app.membership_applications WHERE id = $1', [id])).rows[0]?.status;

async function received(firstName: string, phone?: string) {
  const s = await signIn(t, phone);
  const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': `s1-${s.accountId}` }, body: stage1({ firstName }) });
  return { ...s, applicationId: a.body.id as string };
}

describe('setup', () => {
  it('refuses anything but a staging (or loopback) API', () => {
    expect(checkApi('https://velvet-api-staging.onrender.com')).toBeNull();
    expect(checkApi('http://127.0.0.1:8080')).toBeNull();
    expect(checkApi('https://velvet-api.onrender.com')).toMatch(/staging/);
    expect(checkApi('http://velvet-api-staging.onrender.com')).toMatch(/https/);
    expect(checkApi('https://velvet-api-staging.onrender.com/internal')).toMatch(/yol/);
  });

  it('only ever opens web links', () => {
    expect(safeLink('https://velvet-staging-media.s3.eu-central-1.amazonaws.com/x?X-Amz-Signature=a&b=c')).toBe(true);
    expect(safeLink('http://127.0.0.1:9/v1/storage/object?b=media')).toBe(true);
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'C:\\Windows\\calc.exe', 'http://evil.example/x', 'javascript:alert(1)', '']) expect(safeLink(bad), bad).toBe(false);
  });

  it('checks the key against the API before saving; saves settings readable by the owner only', async () => {
    // The harness's all-scope key is "ops" (the deployed key id is "reviewer", the default).
    env.VELVET_REVIEW_KEY_ID = 'ops';
    const bad = await tool(['kur'], [API, 'owner', 'x'.repeat(40)]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/Anahtar kabul edilmedi/);
    expect(() => statSync(env.VELVET_REVIEW_CONFIG!)).toThrow();

    const ok = await tool(['kur'], [API, 'owner', INTERNAL_KEYS.ops.secret]);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toMatch(/Bağlantı tamam/);
    expect(statSync(env.VELVET_REVIEW_CONFIG!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(env.VELVET_REVIEW_CONFIG!, 'utf8'))).toEqual({ api: API, keyId: 'ops', secret: INTERNAL_KEYS.ops.secret, reviewerId: 'owner' });
  });
});

describe('reviewing', () => {
  it('lists open applications by group; the list file keeps ids only', async () => {
    const a = await received('Defne');
    const qa = await received('Kuzey', '+905550009876');
    const r = await tool(['liste']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Karar bekleyenler/);
    expect(r.out).toMatch(/Defne, 32 · İstanbul\s+Başvuru alındı/);
    expect(r.out).not.toMatch(/Kuzey/);
    expect(r.out).not.toMatch(/Karaosmanoğlu|sebnem\.private|\+90/);
    const ids = listIds();
    expect(ids).toContain(a.applicationId);
    expect(readFileSync(`${env.VELVET_REVIEW_CONFIG}.list`, 'utf8')).not.toMatch(/Defne|İstanbul/);
    expect((await tool(['liste', '--qa'])).out).toMatch(/Kuzey, 32 · İstanbul \[QA\]/);
    void qa;
  });

  it('shows an application, opens its photos (logged), decides only when confirmed, and starts an invited membership', async () => {
    const ap = await applicantInFinalReview(t, { firstName: 'Irmak' });
    await tool(['liste']);
    const ids = listIds();
    const n = String(ids.indexOf(ap.applicationId) + 1);

    const shown = await tool(['goster', n]);
    expect(shown.out).toMatch(/Irmak Karaosmanoğlu-Büyükçekmeceli · 32 \(doğum: 1994-03-14\) · İstanbul, TR/);
    expect(shown.out).toMatch(/Instagram: @sebnem\.private/);
    expect(shown.out).toMatch(/Referans: Gökçe Işıklar \(henüz eşleşmedi\)/);
    expect(shown.out).toMatch(/Meslek: Restoration architect · Atölye Kuzguncuk/);
    expect(shown.out).toMatch(/Durum: Son değerlendirme/);
    expect(shown.out).not.toMatch(/\+90|5551112233/);

    const photos = await tool(['foto', n]);
    expect(photos.opened).toHaveLength(3);
    expect(photos.out).toMatch(/3 görsel tarayıcıda açılıyor/);
    const printed = await tool(['foto', n, '--baglanti']);
    expect(printed.opened).toHaveLength(0);
    expect(printed.out.match(/^ {2}https:\/\/api\.test\/v1\/storage\/object\S+$/gm)).toHaveLength(3);
    const logged = await t.admin.query(`SELECT principal FROM app.media_access_log l JOIN app.application_media m ON m.id = l.media_id WHERE m.application_id = $1`, [ap.applicationId]);
    expect(logged.rows.map((r) => r.principal)).toEqual(Array(6).fill('ops:owner'));

    // Without --evet nothing happens.
    const unconfirmed = await tool(['karar', n, 'APPROVE', '--neden', 'COMMUNITY_FIT']);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.out).toMatch(/--evet/);
    expect(await status(ap.applicationId)).toBe('FINAL_REVIEW');
    // An action the state does not allow is explained, not sent.
    const wrong = await tool(['karar', n, 'START_REVIEW', '--evet']);
    expect([wrong.code, wrong.out]).toEqual([1, expect.stringMatching(/bu durumda \(Son değerlendirme\) yapılamaz/)]);

    const approved = await tool(['karar', n, 'APPROVE', '--neden', 'COMMUNITY_FIT', '--evet']);
    expect(approved.code, approved.out).toBe(0);
    expect(approved.out).toMatch(/Irmak: Son değerlendirme → Onaylandı/);
    const rev = await t.admin.query(`SELECT reviewer_id, reason_code FROM app.application_reviews WHERE application_id = $1 AND action = 'APPROVE'`, [ap.applicationId]);
    expect(rev.rows).toEqual([{ reviewer_id: 'owner', reason_code: 'COMMUNITY_FIT' }]);

    const notYet = await tool(['uyelik', n]);
    expect(notYet.out).toMatch(/^Irmak Karaosmanoğlu-Büyükçekmeceli, 32 · İstanbul — Onaylandı$/m);
    expect(notYet.out).toMatch(/--evet/);
    const invited = await tool(['uyelik', n, '--evet']);
    expect(invited.out).toMatch(/davetli üyelik başladı \(Üye\)/);
    expect(await status(ap.applicationId)).toBe('ACTIVE_MEMBER');
    expect((await t.admin.query('SELECT activation, granted_by FROM app.memberships WHERE account_id = $1', [ap.accountId])).rows[0]).toEqual({
      activation: 'complimentary',
      granted_by: 'owner',
    });
  });

  it('asks for a specific photo when requesting a replacement', async () => {
    const ap = await applicantInFinalReview(t, { firstName: 'Ece' });
    const missing = await tool(['karar', ap.applicationId, 'REQUEST_INFORMATION', '--istek', 'PHOTO_FACE_NOT_CLEAR', '--evet']);
    expect(missing.out).toMatch(/fotoğraf numarası gerekli \(1–3\)/);
    const r = await tool(['karar', ap.applicationId, 'REQUEST_INFORMATION', '--istek', 'PHOTO_FACE_NOT_CLEAR:2', '--istek', 'WORK_UNCLEAR', '--evet']);
    expect(r.code, r.out).toBe(0);
    expect(await status(ap.applicationId)).toBe('MORE_INFORMATION_REQUIRED');
    const reqs = await t.admin.query(`SELECT type, target FROM app.information_requests WHERE application_id = $1 ORDER BY ordinal`, [ap.applicationId]);
    expect(reqs.rows).toEqual([
      { type: 'REPLACE_PHOTO', target: { kind: 'photo', mediaId: ap.photoIds[1] } },
      { type: 'CLARIFY_WORK', target: null },
    ]);
  });

  it('the interactive loop: pick, act, confirm — and approve then invite in one pass', async () => {
    const a = await received('Lale');
    const before = await tool(['liste']);
    const ids = listIds();
    const n = String(ids.indexOf(a.applicationId) + 1);
    void before;
    // 1st option in APPLICATION_RECEIVED is START_REVIEW; confirm; back; quit.
    const r = await tool([], [n, '1', 'e', 'g', 'q']);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    expect(r.out).toMatch(/Lale Karaosmanoğlu-Büyükçekmeceli, 32 · İstanbul — İncelemeye al\. Emin misin\?/);
    expect(r.out).toMatch(/Durum: İnceleniyor · az önce değişti/);
    expect(await status(a.applicationId)).toBe('UNDER_REVIEW');

    const ap = await applicantInFinalReview(t, { firstName: 'Nil' });
    await tool(['liste']);
    const ids2 = listIds();
    const m = String(ids2.indexOf(ap.applicationId) + 1);
    // FINAL_REVIEW options: 1 APPROVE; reason: none; confirm; invite now: yes; back; quit.
    const r2 = await tool([], [m, '1', '', 'e', 'e', 'g', 'q']);
    expect(r2.code, r2.out).toBe(0);
    expect(r2.out).toMatch(/Davetli üyelik başladı/);
    expect(await status(ap.applicationId)).toBe('ACTIVE_MEMBER');
  });

  it('a declined confirmation changes nothing', async () => {
    const a = await received('Rüya');
    await review(t, a.applicationId, { kind: 'START_REVIEW' });
    await tool(['liste']);
    const ids = listIds();
    const n = String(ids.indexOf(a.applicationId) + 1);
    // UNDER_REVIEW options: 1 REQUEST_EXTENDED; decline; back; quit.
    const r = await tool([], [n, '1', 'h', 'g', 'q']);
    expect(r.out).toMatch(/Vazgeçildi/);
    expect(await status(a.applicationId)).toBe('UNDER_REVIEW');
  });

  it('numbers come from the last `liste` only: the interactive mode never rewrites it, and an old list is refused', async () => {
    await tool(['liste']);
    const before = readFileSync(`${env.VELVET_REVIEW_CONFIG}.list`, 'utf8');
    await tool([], ['h', 'q']); // browse in the interactive mode (toggle "all", quit)
    expect(readFileSync(`${env.VELVET_REVIEW_CONFIG}.list`, 'utf8')).toBe(before);
    t.clock.set(new Date(t.clock.now().getTime() + 3 * 60 * 60 * 1000).toISOString());
    expect((await tool(['goster', '1'])).out).toMatch(/Son liste eski/);
    await tool(['liste']);
    expect((await tool(['goster', '1'])).code).toBe(0);
  });

  it('plain-language errors: unknown number, stale id, wrong key', async () => {
    expect((await tool(['goster', '999'])).out).toMatch(/Son listede 999 numaralı başvuru yok/);
    expect((await tool(['goster', 'app_doesnotexist'])).out).toMatch(/Başvuru bulunamadı/);
    const wrongKey = { ...env, VELVET_REVIEW_KEY_SECRET: 'y'.repeat(44) };
    const s = io();
    expect(await run(['liste'], s.io, wrongKey, { fetch: fetchImpl as never, signingEnv: 'test' })).toBe(1);
    expect(s.out()).toMatch(/Anahtar kabul edilmedi.*\(istek: req_/s);
  });
});
