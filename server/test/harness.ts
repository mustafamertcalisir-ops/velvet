/**
 * Test harness: a fresh database (cloned from the migrated template), the
 * real services and HTTP app, a controllable clock, captured SMS codes, a
 * captured structured log and a temporary local object store. Requests go
 * through the full Hono stack in-process (routing, auth, error mapping,
 * DTOs, signed storage urls) — no mocks of our own code.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { inject } from 'vitest';
import type { DatingSettingsInput } from '@/domain/member/dating';
import type { IntroductionPolicy } from '@/domain/member/introductions';
import type { ReviewerAction } from '@/domain/admission/review';
import type { CompletedUpload, MediaClass, UploadAuthorization } from '@/services/api/contract';
import { captureSms, type SmsProvider } from '../src/auth/sms';
import { INTERNAL_SCOPES, loadConfig, type Config } from '../src/config';
import { createPool } from '../src/db/pool';
import { createApp } from '../src/http/app';
import { signInternalRequest } from '../src/http/internalAuth';
import { memoryLogger } from '../src/lib/log';
import { localObjectStore, type ObjectStore } from '../src/media/objectStore';
import { createServices } from '../src/services';
import { RUNTIME_TEST_ROLE } from './globalSetup';

/** Internal callers of the test server: one key with every scope, one with review only. */
export const INTERNAL_KEYS = {
  ops: { secret: 'test-internal-ops-secret-0123456789abcdef0123', scopes: [...INTERNAL_SCOPES] },
  reviewer: { secret: 'test-internal-reviewer-secret-0123456789abcd', scopes: ['review:write'] },
};
export const BASE_URL = 'https://api.test';

export type Res<T = any> = { status: number; body: T; headers?: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function testServer(
  start = '2026-10-05T09:00:00.000Z',
  env: Record<string, string> = {},
  opts: {
    policy?: IntroductionPolicy;
    sms?: (ctx: { pool: pg.Pool; config: Config; clock: () => Date }) => SmsProvider;
    store?: (clock: () => Date) => ObjectStore;
  } = {},
) {
  const adminUrl = inject('adminUrl');
  const template = inject('templateDb');
  const name = `velvet_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (let i = 0; ; i++) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      break;
    } catch (e) {
      if (i > 20 || (e as { code?: string }).code !== '55006') throw e; // template busy: another file is cloning
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  // The services connect as the least-privilege runtime role, exactly as deployed (DEC-074);
  // `admin` (the owner) is only for test fixtures and failure injection.
  const runtimeUrl = new URL(url);
  runtimeUrl.username = RUNTIME_TEST_ROLE;
  const pool = createPool(runtimeUrl.toString(), 20);
  const adminPool = createPool(url.toString(), 3);
  const mediaDir = mkdtempSync('/tmp/velvet-media-');

  let now = new Date(start);
  const clock = () => now;
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: url.toString(),
    OTP_SECRET: 'test-otp-secret-0123456789abcdef0123456789',
    MEDIA_SIGNING_SECRET: 'test-media-secret-0123456789abcdef01234567',
    INTERNAL_KEYS_JSON: JSON.stringify(INTERNAL_KEYS),
    SMS_PROVIDER: 'capture',
    PUBLIC_BASE_URL: BASE_URL,
    STORAGE_DRIVER: 'local',
    MEDIA_DIR: mediaDir,
    LOG_LEVEL: 'debug',
    ...env,
  });
  const sms = captureSms();
  const { logger: log, lines: logLines } = memoryLogger('debug');
  const store = opts.store?.(clock) ?? localObjectStore({ dir: mediaDir, baseUrl: BASE_URL, secret: config.mediaSigningSecret, clock });
  const services = createServices({ pool, config, clock, sms: opts.sms?.({ pool, config, clock }) ?? sms, store, log, policy: opts.policy });
  const app = createApp(services);

  async function request<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; rawBody?: string | Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { 'x-forwarded-for': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined || typeof opts.rawBody === 'string') headers['content-type'] ??= 'application/json';
    const payload = opts.rawBody !== undefined ? opts.rawBody : opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const res = await app.request(path.startsWith(BASE_URL) ? path.slice(BASE_URL.length) : path, {
      method,
      headers,
      body: payload === '' ? undefined : (payload as BodyInit | undefined),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* raw */
    }
    return { status: res.status, body: body as T, headers: res.headers };
  }

  /** A signed internal request (as operator tooling would send it). */
  async function internal<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
    method: string,
    path: string,
    body?: unknown,
    opts: { keyId?: keyof typeof INTERNAL_KEYS | string; secret?: string; nonce?: string; now?: Date; headers?: Record<string, string> } = {},
  ): Promise<Res<T>> {
    const keyId = opts.keyId ?? 'ops';
    const raw = body === undefined ? '' : JSON.stringify(body);
    const secret = opts.secret ?? INTERNAL_KEYS[keyId as keyof typeof INTERNAL_KEYS]?.secret ?? 'unknown-key-secret-0000000000000000000';
    const headers = {
      ...signInternalRequest({ env: config.appEnv, keyId, secret, method, pathAndQuery: path, body: raw, now: opts.now ?? now, nonce: opts.nonce }),
      ...opts.headers,
    };
    return request<T>(method, path, { headers, rawBody: raw });
  }

  return {
    app,
    pool,
    /** The schema owner — fixtures and failure injection only. */
    admin: adminPool,
    services,
    sms,
    config,
    mediaDir,
    store,
    logLines,
    request,
    internal,
    clock: {
      set: (iso: string) => (now = new Date(iso)),
      advanceDays: (d: number) => (now = new Date(now.getTime() + d * 86_400_000)),
      now: () => now,
    },
    async close() {
      await pool.end();
      await adminPool.end();
      rmSync(mediaDir, { recursive: true, force: true });
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await c.end();
    },
  };
}

export type T = Awaited<ReturnType<typeof testServer>>;

/** A small JPEG carrying EXIF text that must never survive an upload. */
export async function jpegBytesWithExif(seed = 0): Promise<Buffer> {
  return sharp({ create: { width: 60 + seed, height: 80, channels: 3, background: { r: 120, g: 50 + seed, b: 70 } } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'SECRET-EXIF-MARKER', ImageDescription: 'GPS 41.0082N 28.9784E', Artist: 'Device Owner' } })
    .toBuffer();
}
export async function jpegWithExif(seed = 0): Promise<string> {
  return `data:image/jpeg;base64,${(await jpegBytesWithExif(seed)).toString('base64')}`;
}

/**
 * The full direct-upload flow through the API: authorise → PUT to the signed
 * storage url → complete. Answers the completion response (or the first error).
 */
export async function upload(
  t: Pick<T, 'request'>,
  token: string,
  image: Buffer | string,
  o: { mediaClass?: MediaClass; requestId?: string | null; contentType?: string; declaredBytes?: number } = {},
): Promise<Res & { auth?: UploadAuthorization }> {
  const bytes = typeof image === 'string' ? Buffer.from(image.replace(/^data:[^,]+,/, ''), 'base64') : image;
  const auth = await t.request<UploadAuthorization>('POST', '/v1/media/uploads', {
    token,
    body: {
      mediaClass: o.mediaClass ?? 'APPLICATION_MEDIA',
      contentType: o.contentType ?? 'image/jpeg',
      byteLength: o.declaredBytes ?? bytes.length,
      requestId: o.requestId ?? null,
    },
  });
  if (auth.status !== 200) return auth as unknown as Res<CompletedUpload>;
  const put = auth.body.upload.url.startsWith(BASE_URL)
    ? await t.request('PUT', auth.body.upload.url, { rawBody: new Uint8Array(bytes), headers: auth.body.upload.headers })
    : await fetch(auth.body.upload.url, { method: 'PUT', headers: auth.body.upload.headers, body: new Uint8Array(bytes) }).then(async (r) => ({
        status: r.status,
        body: await r.text(),
      }));
  if (put.status !== 200) return put as Res;
  const done = await t.request<CompletedUpload>('POST', `/v1/media/uploads/${auth.body.uploadId}/complete`, { token });
  return { ...done, auth: auth.body };
}

/** An application photo through the direct-upload flow; answers like the old endpoint did (the media DTO, or the error). */
export async function uploadApplicationPhoto(t: Pick<T, 'request'>, token: string, dataUri: string, requestId?: string, mediaClass?: MediaClass) {
  const r = await upload(t, token, dataUri, { requestId, mediaClass });
  return r.status === 200 ? { status: 200, body: r.body.applicationMedia as any } : r; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** GET a signed delivery url through the app. */
export async function fetchSigned(t: Pick<T, 'app'>, url: string) {
  const res = await t.app.request(url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url);
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

let phoneSeq = 0;
export const nextPhone = () => `+90532${String(1_000_000 + process.pid * 100 + phoneSeq++).slice(-7)}`;

export async function signIn(t: T, phone = nextPhone()) {
  const otp = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
  if (otp.status !== 200) throw new Error(`otp ${otp.status} ${JSON.stringify(otp.body)}`);
  const code = t.sms.last(phone)!;
  const v = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code } });
  if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
  return { token: v.body.session.token as string, accountId: v.body.session.userId as string, phone };
}

export const stage1 = (over: Record<string, unknown> = {}) => ({
  firstName: 'Şebnem',
  lastName: 'Karaosmanoğlu-Büyükçekmeceli',
  dateOfBirth: '1994-03-14',
  instagram: { kind: 'handle', handle: 'sebnem.private' },
  countryCode: 'TR',
  city: { kind: 'listed', cityId: 'TR-istanbul', label: 'İstanbul', region: null },
  referral: { kind: 'requested', referrals: [{ id: 'r1', name: 'Gökçe Işıklar', phoneE164: '+905551112233' }] },
  ...over,
});

export async function review(t: T, applicationId: string, action: ReviewerAction) {
  const r = await t.internal('POST', `/internal/reviewer/applications/${applicationId}/actions`, { reviewerId: 'reviewer.one', action });
  if (r.status !== 200) throw new Error(`review ${action.kind} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function seedPlan(t: T) {
  await t.admin.query(
    `INSERT INTO app.membership_plans (id, name, billing_period, price_minor, currency, is_development_fixture)
     VALUES ('plan_test', 'Membership', 'monthly', 250000, 'TRY', true) ON CONFLICT DO NOTHING`,
  );
}

export type ApplicantOpts = {
  firstName?: string;
  dateOfBirth?: string;
  intents?: string[];
  meet?: string[];
  ageRange?: { min: number; max: number };
  phone?: string;
};

/** Phone → Stage 1 → review → Stage 2 (3 photos) → FINAL_REVIEW. */
export async function applicantInFinalReview(t: T, o: ApplicantOpts = {}) {
  const s = await signIn(t, o.phone);
  const a = await t.request('POST', '/v1/application', {
    token: s.token,
    headers: { 'Idempotency-Key': `s1-${s.accountId}` },
    body: stage1({ firstName: o.firstName ?? 'Şebnem', dateOfBirth: o.dateOfBirth ?? '1994-03-14' }),
  });
  if (a.status !== 200) throw new Error(`stage1 ${a.status} ${JSON.stringify(a.body)}`);
  const applicationId = a.body.id as string;
  await review(t, applicationId, { kind: 'START_REVIEW' });
  await review(t, applicationId, { kind: 'REQUEST_EXTENDED' });
  await t.request('POST', '/v1/application/extended/start', { token: s.token });
  const photoIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const up = await upload(t, s.token, await jpegBytesWithExif(i));
    if (up.status !== 200) throw new Error(`upload ${up.status} ${JSON.stringify(up.body)}`);
    photoIds.push(up.body.mediaId);
  }
  const intents = o.intents ?? ['dating', 'community'];
  const dating = intents.includes('dating');
  const s2 = await t.request('POST', '/v1/application/extended', {
    token: s.token,
    headers: { 'Idempotency-Key': `s2-${s.accountId}` },
    body: {
      photoIds,
      occupation: 'Restoration architect',
      workContext: { kind: 'organisation', name: 'Atölye Kuzguncuk' },
      whatYouDo: 'Restoring wooden yalı houses on the Asian shore with a small team of carpenters.',
      aboutYou: 'PRIVATE-ABOUT-YOU: I swim in the Bosphorus every morning from May until the water turns.',
      interests: ['Architecture', 'Swimming', 'Jazz'],
      intents,
      datingPreferences: dating ? { meet: o.meet ?? ['everyone'], ageRange: o.ageRange ?? { min: 25, max: 45 } } : null,
    },
  });
  if (s2.status !== 200) throw new Error(`stage2 ${s2.status} ${JSON.stringify(s2.body)}`);
  return { ...s, applicationId, photoIds };
}

/** …→ APPROVED → MEMBERSHIP_PAYMENT_REQUIRED → (provider confirms) → ACTIVE_MEMBER. */
export async function activeMember(t: T, o: ApplicantOpts & { dating?: DatingSettingsInput | false } = {}) {
  const ap = await applicantInFinalReview(t, o);
  await seedPlan(t);
  await review(t, ap.applicationId, { kind: 'APPROVE', reason: 'COMMUNITY_FIT' });
  const b = await t.request('POST', '/v1/membership/begin', { token: ap.token });
  if (b.status !== 200) throw new Error(`begin ${b.status} ${JSON.stringify(b.body)}`);
  const pay = await t.internal('POST', '/internal/billing/payment-confirmed', {
    accountId: ap.accountId,
    providerEventId: `evt_${ap.accountId}`,
    provider: 'test',
  });
  if (pay.status !== 200) throw new Error(`pay ${pay.status} ${JSON.stringify(pay.body)}`);
  const me = await t.request('GET', '/v1/member/me', { token: ap.token });
  if (me.status !== 200) throw new Error(`me ${me.status} ${JSON.stringify(me.body)}`);
  const memberId = me.body.profile.memberId as string;
  if (o.dating) {
    const d = await t.request('PUT', '/v1/member/me/dating', { token: ap.token, body: o.dating });
    if (d.status !== 200) throw new Error(`dating ${d.status} ${JSON.stringify(d.body)}`);
  }
  return { ...ap, memberId };
}

