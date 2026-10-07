/**
 * Shared client for the tools that run against a DEPLOYED staging API (or the
 * local staging-shaped rehearsal): the smoke flow, the QA seed, the staging
 * suites and the OTP check. Black-box over HTTP; no database access.
 *
 * Safety rails (every tool):
 *   - refuses to start unless STAGING_ENVIRONMENT=staging;
 *   - the API must be https with "staging" in its host name (or plain http
 *     on a loopback address, for the local rehearsal);
 *   - before ANY code request, a signed preflight to a staging-only route
 *     (`/internal/test/client-address`) must succeed — production does not
 *     serve it and refuses staging-bound signatures, so a tool pointed at
 *     production stops before a single SMS could be sent;
 *   - internal requests are signed for the `staging` environment, so a
 *     production API refuses them, and the routes these tools need
 *     (`/internal/test/*`) do not exist in production at all;
 *   - accounts are created ONLY on designated test numbers
 *     (STAGING_PHONE_PREFIX, which must be covered by the server's
 *     SMS_TEST_NUMBERS) — such accounts are QA accounts (0011).
 *
 * Environment (the SMOKE_* names are accepted as aliases):
 *   STAGING_ENVIRONMENT=staging
 *   STAGING_API_URL            https://api-staging.<domain>
 *   STAGING_KEY_ID / STAGING_KEY_SECRET   an internal key with test:otp and test:review
 *   STAGING_PHONE_PREFIX       e.g. +90555000 (designated test numbers on the server)
 */
import { randomInt } from 'node:crypto';
import sharp from 'sharp';
import { signInternalRequest } from '../../src/http/internalAuth';

export type Res = { status: number; body: any; headers: Headers; ms: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type StagingEnv = { api: string; keyId: string; keySecret: string; prefix: string };

export function stagingEnv(env: Record<string, string | undefined> = process.env): StagingEnv {
  const get = (name: string) => env[`STAGING_${name}`] ?? env[`SMOKE_${name}`] ?? '';
  if (get('ENVIRONMENT') !== 'staging') throw new Error('Refusing to run: set STAGING_ENVIRONMENT=staging (this tool creates QA accounts on test numbers).');
  const api = get('API_URL').replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new Error('STAGING_API_URL is required.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('STAGING_API_URL must use https.');
  if (!loopback && !/staging/i.test(url.hostname)) throw new Error('Refusing to run: STAGING_API_URL must be the staging API (its host name must say "staging").');
  const e = { api, keyId: get('KEY_ID'), keySecret: get('KEY_SECRET'), prefix: get('PHONE_PREFIX') };
  if (!e.keyId || !e.keySecret) throw new Error('STAGING_KEY_ID and STAGING_KEY_SECRET are required.');
  if (!/^\+\d{4,12}$/.test(e.prefix)) throw new Error('STAGING_PHONE_PREFIX must be an E.164 prefix of designated test numbers, e.g. +90555000.');
  return e;
}

/** Result recorder: one line per check; the summary decides the exit code. */
export function recorder(label: string) {
  const results: { name: string; ok: boolean; detail?: string; status?: 'PASS' | 'FAIL' | 'BLOCKED' }[] = [];
  return {
    results,
    check(name: string, ok: boolean, detail = '') {
      results.push({ name, ok, detail, status: ok ? 'PASS' : 'FAIL' });
      console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
      return ok;
    },
    blocked(name: string, why: string) {
      results.push({ name, ok: true, detail: why, status: 'BLOCKED' });
      console.log(`– ${name} — BLOCKED: ${why}`);
    },
    summary() {
      const failed = results.filter((r) => r.status === 'FAIL');
      const blocked = results.filter((r) => r.status === 'BLOCKED');
      console.log(`\n${label}: ${results.length - failed.length - blocked.length}/${results.length - blocked.length} checks passed${blocked.length ? `, ${blocked.length} blocked` : ''}`);
      return failed.length === 0;
    },
  };
}

export type Person = {
  name: string;
  phone: string;
  token: string;
  accountId: string;
  applicationId: string;
  memberId?: string;
  status?: string;
  /** Short-lived signed urls of the applicant's own processed photos (from the upload completions). */
  photoUrls?: string[];
};

export function stagingClient(e: StagingEnv) {
  // Local rehearsal only: a simulated client address per tool run (the API trusts one proxy hop, so on a
  // real deployment the platform's own appended address is what counts and this header changes nothing).
  const forwarded: Record<string, string> = process.env.STAGING_SIMULATED_CLIENT_IP ? { 'x-forwarded-for': process.env.STAGING_SIMULATED_CLIENT_IP } : {};
  async function call(method: string, path: string, o: { token?: string; body?: unknown; raw?: string | Uint8Array; headers?: Record<string, string> } = {}): Promise<Res> {
    const headers: Record<string, string> = { accept: 'application/json', ...forwarded, ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined || o.raw !== undefined) headers['content-type'] ??= 'application/json';
    const started = Date.now();
    const payload: BodyInit | undefined = o.raw !== undefined ? (o.raw as BodyInit) : o.body === undefined ? undefined : JSON.stringify(o.body);
    const r = await fetch(`${e.api}${path}`, { method, headers, body: payload });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, body, headers: r.headers, ms: Date.now() - started };
  }

  /** A signed internal request (bound to the staging environment). */
  async function internal(path: string, body: unknown = {}, method = 'POST', extra: Record<string, string> = {}): Promise<Res> {
    const raw = JSON.stringify(body);
    const headers = signInternalRequest({ env: 'staging', keyId: e.keyId, secret: e.keySecret, method, pathAndQuery: path, body: raw, now: new Date() });
    return call(method, path, { raw, headers: { ...headers, 'content-type': 'application/json', ...extra } });
  }

  /** The signed staging-only preflight: throws unless this API serves staging test routes for this key. */
  async function preflight(): Promise<{ address: string; privateRange: boolean; hops: number }> {
    const r = await internal('/internal/test/client-address', {});
    if (r.status !== 200 || typeof r.body?.address !== 'string') {
      throw new Error(`Refusing to continue: ${e.api} did not accept the staging preflight (${r.status}). Not a staging API, or the key lacks test:review.`);
    }
    return r.body;
  }

  const digits = 13 - e.prefix.length;
  /** A random designated test number. */
  const testPhone = () => `${e.prefix}${String(randomInt(0, 10 ** Math.max(1, digits))).padStart(digits, '0')}`;
  /** A deterministic designated test number (QA seed: repeatable). */
  const fixedPhone = (n: number) => `${e.prefix}${String(n).padStart(digits, '0')}`;

  async function signIn(phone: string): Promise<{ token: string; accountId: string }> {
    let otp = await call('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    // The per-number resend cooldown (30 s) — e.g. a repeated QA seed run: wait it out once.
    const wait = Number(otp.body?.error?.retryAfterMs ?? 0);
    if (otp.body?.error?.code === 'RATE_LIMITED' && wait > 0 && wait <= 35_000) {
      await new Promise((r) => setTimeout(r, wait + 250));
      otp = await call('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    }
    if (otp.status !== 200) throw new Error(`OTP request ${otp.status} ${JSON.stringify(otp.body)}`);
    const code = await internal('/internal/test/otp', { phoneE164: phone });
    if (code.status !== 200) throw new Error(`test outbox ${code.status} — is ${e.prefix}* in the server's SMS_TEST_NUMBERS?`);
    const v = await call('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code: code.body.code } });
    if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
    return { token: v.body.session.token, accountId: v.body.session.userId };
  }

  /** A generated photo (never a bundled asset); EXIF added so stripping can be checked. */
  async function photo(seed: number, marker = 'STAGING-EXIF-MARKER'): Promise<Buffer> {
    return sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 40 + ((seed * 37) % 180), g: 70 + ((seed * 13) % 100), b: 90 } } })
      .jpeg({ quality: 80 })
      .withExif({ IFD0: { Copyright: marker, ImageDescription: 'GPS 41.0082N 28.9784E' } })
      .toBuffer();
  }

  async function upload(token: string, mediaClass: string, bytes: Buffer, requestId: string | null = null): Promise<Res> {
    const auth = await call('POST', '/v1/media/uploads', { token, body: { mediaClass, contentType: 'image/jpeg', byteLength: bytes.length, requestId } });
    if (auth.status !== 200) return auth;
    const put = await fetch(auth.body.upload.url, { method: 'PUT', headers: auth.body.upload.headers, body: new Uint8Array(bytes) });
    if (!put.ok) return { status: put.status, body: await put.text(), headers: put.headers, ms: 0 };
    return call('POST', `/v1/media/uploads/${auth.body.uploadId}/complete`, { token });
  }

  const fixture = (applicationId: string, action: string) => internal(`/internal/test/applications/${applicationId}/review`, { action });

  /**
   * An applicant on a test number, brought to FINAL_REVIEW through the public
   * API (Stage 1, real uploads, Stage 2) and the review fixture. Resumable:
   * signing in again continues from the application's current status.
   */
  async function applicant(o: { name: string; dob: string; intents: string[]; meet?: string[] | null; ageRange?: { min: number; max: number }; phone?: string; stopAt?: string }): Promise<Person> {
    const phone = o.phone ?? testPhone();
    const s = await signIn(phone);
    let app = (await call('GET', '/v1/me/application', { token: s.token })).body.application as { id: string; status: string } | null;
    if (!app) {
      const a = await call('POST', '/v1/application', {
        token: s.token,
        headers: { 'Idempotency-Key': `qa-s1-${s.accountId}` },
        body: {
          firstName: o.name,
          lastName: 'Soyadqa', // a distinctive private value: privacy checks look for it in public responses
          dateOfBirth: o.dob,
          instagram: { kind: 'handle', handle: `qa.${o.name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'member'}` },
          countryCode: 'TR',
          city: { kind: 'listed', cityId: 'TR-istanbul', label: 'İstanbul', region: null },
          referral: { kind: 'none' },
        },
      });
      if (a.status !== 200) throw new Error(`stage 1 ${a.status} ${JSON.stringify(a.body)}`);
      app = a.body;
    }
    const photoUrls: string[] = [];
    const step = async (action: string) => {
      const r = await fixture(app!.id, action);
      if (r.status !== 200) throw new Error(`fixture ${action} ${r.status} ${JSON.stringify(r.body)}`);
      app = r.body;
    };
    if (o.stopAt === 'APPLICATION_RECEIVED') return { ...s, phone, name: o.name, applicationId: app!.id, status: app!.status };
    if (app!.status === 'APPLICATION_RECEIVED') await step('START_REVIEW');
    if (o.stopAt === 'UNDER_REVIEW') return { ...s, phone, name: o.name, applicationId: app!.id, status: app!.status };
    if (app!.status === 'UNDER_REVIEW') await step('REQUEST_EXTENDED');
    if (o.stopAt === 'EXTENDED_APPLICATION_REQUIRED') return { ...s, phone, name: o.name, applicationId: app!.id, status: app!.status };
    if (app!.status === 'EXTENDED_APPLICATION_REQUIRED' || app!.status === 'EXTENDED_APPLICATION_DRAFT') {
      await call('POST', '/v1/application/extended/start', { token: s.token });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const u = await upload(s.token, 'APPLICATION_MEDIA', await photo(i + o.name.length));
        if (u.status !== 200) throw new Error(`upload ${u.status} ${JSON.stringify(u.body)}`);
        ids.push(u.body.mediaId);
        if (u.body.applicationMedia?.storageKey) photoUrls.push(u.body.applicationMedia.storageKey);
      }
      const dating = o.intents.includes('dating');
      const s2 = await call('POST', '/v1/application/extended', {
        token: s.token,
        headers: { 'Idempotency-Key': `qa-s2-${s.accountId}` },
        body: {
          photoIds: ids,
          occupation: 'Staging QA account',
          workContext: { kind: 'independent' },
          whatYouDo: 'An isolated staging QA account created by the staging tooling.',
          aboutYou: 'This account exists only to verify the staging deployment.',
          interests: ['Architecture', 'Swimming', 'Jazz'],
          intents: o.intents,
          datingPreferences: dating ? { meet: o.meet ?? ['everyone'], ageRange: o.ageRange ?? { min: 25, max: 45 } } : null,
        },
      });
      if (s2.status !== 200) throw new Error(`stage 2 ${s2.status} ${JSON.stringify(s2.body)}`);
      app = s2.body;
    }
    return { ...s, phone, name: o.name, applicationId: app!.id, status: app!.status, photoUrls };
  }

  /** …→ APPROVED → MEMBERSHIP_PAYMENT_REQUIRED → (fixture activation) → ACTIVE_MEMBER, with Dating settings. */
  async function member(o: Parameters<typeof applicant>[0] & { dating?: { gender: string; seeking: string[]; ageRange: { min: number; max: number } } }): Promise<Person> {
    const p = await applicant(o);
    let status = p.status;
    if (status === 'FINAL_REVIEW') {
      const r = await fixture(p.applicationId, 'APPROVE');
      if (r.status !== 200) throw new Error(`approve ${r.status} ${JSON.stringify(r.body)}`);
      status = r.body.status;
    }
    if (status === 'APPROVED') {
      const b = await call('POST', '/v1/membership/begin', { token: p.token });
      if (b.status !== 200) throw new Error(`begin membership ${b.status} ${JSON.stringify(b.body)} — is a staging plan configured?`);
      status = b.body.application.status;
    }
    if (status === 'MEMBERSHIP_PAYMENT_REQUIRED') {
      const r = await fixture(p.applicationId, 'ACTIVATE');
      if (r.status !== 200) throw new Error(`activate ${r.status} ${JSON.stringify(r.body)}`);
      status = r.body.status;
    }
    const me = await call('GET', '/v1/member/me', { token: p.token });
    if (me.status !== 200) throw new Error(`member ${me.status} ${JSON.stringify(me.body)}`);
    if (o.dating) {
      const d = await call('PUT', '/v1/member/me/dating', { token: p.token, body: o.dating });
      if (d.status !== 200) throw new Error(`dating ${d.status} ${JSON.stringify(d.body)}`);
    }
    return { ...p, status, memberId: me.body.profile.memberId };
  }

  /** A birth date making someone exactly `age` today (Istanbul), well away from the birthday. */
  function dobForAge(age: number): string {
    const d = new Date(Date.now() - 100 * 86_400_000);
    d.setUTCFullYear(d.getUTCFullYear() - age);
    return d.toISOString().slice(0, 10);
  }

  return { call, internal, preflight, testPhone, fixedPhone, signIn, photo, upload, fixture, applicant, member, dobForAge };
}

export type StagingClient = ReturnType<typeof stagingClient>;

/** Mask a phone number for console output: only the last four digits. */
export const maskPhone = (p: string) => `••• ${p.slice(-4)}`;
