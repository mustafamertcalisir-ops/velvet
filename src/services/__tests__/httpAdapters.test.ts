/**
 * The HTTP adapters: routes, headers, bodies and error mapping — against a
 * fake fetch. (server/test/contract.test.ts runs the same adapters against
 * the real API.)
 */
import { resolveBackend } from '@/config';
import { API_ERROR_CODES, ROUTES, toClientError } from '../api/contract';
import { createHttpAdmissionApi } from '../http/httpAdmissionApi';
import { createHttpClient } from '../http/httpClient';
import { createHttpMemberApi } from '../http/httpMemberApi';
import { toBase64 } from '@/lib/testing/toBase64';

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(reply: (s: Seen) => { status: number; json?: unknown } | Error) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const s: Seen = {
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body instanceof Uint8Array ? { bytes: init.body.length } : init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    const r = reply(s);
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.json === undefined) throw new Error('no body');
        return r.json;
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const session = { token: 'tok_abc', userId: 'usr_1' };

describe('HTTP adapters', () => {
  it('send the session as a bearer token, idempotency keys as a header, bodies as JSON', async () => {
    const { seen, fetchImpl } = fakeFetch(() => ({ status: 200, json: { ok: 1 } }));
    const call = createHttpClient({ baseUrl: 'https://api.example.com/', fetch: fetchImpl });
    const admission = createHttpAdmissionApi(call);
    const member = createHttpMemberApi(call);
    await admission.requestOtp('+905321234567');
    await admission.submitStage1(session, 'sub_1', { firstName: 'Şebnem' } as never);
    await member.react(session, 'itr_1', 'LIKE');
    await member.sendMessage(session, 'cnv_1', 'Merhaba', 'cm_1');
    await member.saveDatingSettings(session, { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 28, max: 40 } });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST https://api.example.com/v1/auth/otp',
      'POST https://api.example.com/v1/application',
      'POST https://api.example.com/v1/introductions/itr_1/reaction',
      'POST https://api.example.com/v1/conversations/cnv_1/messages',
      'PUT https://api.example.com/v1/member/me/dating',
    ]);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(seen[1]!.headers).toMatchObject({ Authorization: 'Bearer tok_abc', 'Idempotency-Key': 'sub_1', 'Content-Type': 'application/json' });
    expect(seen[2]!.body).toEqual({ type: 'LIKE' });
    expect(seen[3]!.body).toEqual({ body: 'Merhaba', clientMessageId: 'cm_1' });
    // The account id is never sent: the token identifies the session.
    expect(JSON.stringify(seen)).not.toContain('usr_1');
  });

  it('upload photos directly to private storage: authorise → PUT bytes (no session) → complete; never base64 through the API', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const b64 = toBase64(jpeg);
    const media = { id: 'med_1', applicationId: 'app_1', type: 'photo', purpose: 'profile', storageKey: 'https://signed', order: 0, moderationStatus: 'pending', requestId: 'req_1', retiredAt: null, createdAt: 'x' };
    const { seen, fetchImpl } = fakeFetch((s) =>
      s.url.endsWith('/v1/media/uploads')
        ? { status: 200, json: { uploadId: 'upl_1', mediaClass: 'VERIFICATION_MEDIA', upload: { url: 'https://storage.example.com/b/k?sig=1', method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } }, expiresAt: 'x' } }
        : s.method === 'PUT'
          ? { status: 200, json: {} }
          : { status: 200, json: { uploadId: 'upl_1', mediaClass: 'VERIFICATION_MEDIA', mediaId: 'med_1', applicationMedia: media, member: null } },
    );
    const admission = createHttpAdmissionApi(createHttpClient({ baseUrl: 'https://api.example.com', fetch: fetchImpl }));
    const res = await admission.uploadApplicationPhoto(session, { dataUri: `data:image/jpeg;base64,${b64}`, width: 1, height: 2 }, { requestId: 'req_1', mediaClass: 'VERIFICATION_MEDIA' });
    expect(res).toEqual({ ok: true, value: media });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST https://api.example.com/v1/media/uploads',
      'PUT https://storage.example.com/b/k?sig=1',
      'POST https://api.example.com/v1/media/uploads/upl_1/complete',
    ]);
    expect(seen[0]!.body).toEqual({ mediaClass: 'VERIFICATION_MEDIA', contentType: 'image/jpeg', byteLength: jpeg.length, requestId: 'req_1' });
    expect(seen[1]!.headers).toEqual({ 'Content-Type': 'image/jpeg' }); // no Authorization to storage
    expect(seen[1]!.body).toEqual({ bytes: jpeg.length });
    expect(JSON.stringify(seen)).not.toContain(b64);
    // A storage failure is a retryable network error; a non-image is refused before any request.
    const failing = fakeFetch((s) => (s.method === 'PUT' ? { status: 403 } : { status: 200, json: { uploadId: 'upl_2', upload: { url: 'https://s/x', method: 'PUT', headers: {} } } }));
    const a2 = createHttpAdmissionApi(createHttpClient({ baseUrl: 'https://api.example.com', fetch: failing.fetchImpl }));
    expect(await a2.uploadApplicationPhoto(session, { dataUri: `data:image/jpeg;base64,${b64}`, width: 1, height: 1 })).toEqual({ ok: false, error: { kind: 'network' } });
    expect(await a2.uploadApplicationPhoto(session, { dataUri: 'data:text/html;base64,PGI+', width: 1, height: 1 })).toEqual({ ok: false, error: { kind: 'validation', fields: ['photo'] } });
  });

  it('encode path parameters', async () => {
    const { seen, fetchImpl } = fakeFetch(() => ({ status: 200, json: {} }));
    const member = createHttpMemberApi(createHttpClient({ baseUrl: 'https://api.example.com', fetch: fetchImpl }));
    await member.getMemberProfile(session, '../admin?x=1');
    expect(seen[0]!.url).toBe('https://api.example.com/v1/members/..%2Fadmin%3Fx%3D1');
  });

  it('map typed errors onto the app’s error union; transport failures are retryable network errors', async () => {
    const replies: ({ status: number; json?: unknown } | Error)[] = [
      { status: 403, json: { error: { code: 'MEMBERSHIP_REQUIRED', message: '' } } },
      { status: 409, json: { error: { code: 'REACTION_ALREADY_RECORDED', message: '' } } },
      { status: 429, json: { error: { code: 'RATE_LIMITED', message: '', retryAfterMs: 1234 } } },
      { status: 422, json: { error: { code: 'INVALID_CODE', message: '', attemptsRemaining: 2 } } },
      { status: 422, json: { error: { code: 'VALIDATION_FAILED', message: '', fields: ['seeking'] } } },
      { status: 500, json: { error: { code: 'INTERNAL', message: '' } } },
      { status: 502 },
      new TypeError('Network request failed'),
    ];
    let i = 0;
    const { fetchImpl } = fakeFetch(() => replies[i++]!);
    const member = createHttpMemberApi(createHttpClient({ baseUrl: 'https://api.example.com', fetch: fetchImpl }));
    const out = [];
    for (let k = 0; k < replies.length; k++) out.push(await member.getMe(session));
    expect(out.map((r) => (r.ok ? 'ok' : r.error))).toEqual([
      { kind: 'membership_required' },
      { kind: 'reaction_already_recorded' },
      { kind: 'rate_limited', retryAfterMs: 1234 },
      { kind: 'invalid_code', attemptsRemaining: 2 },
      { kind: 'validation', fields: ['seeking'] },
      { kind: 'server' },
      { kind: 'network' },
      { kind: 'network' },
    ]);
  });

  it('without an API URL every call fails closed', async () => {
    const { seen, fetchImpl } = fakeFetch(() => ({ status: 200, json: {} }));
    const api = createHttpAdmissionApi(createHttpClient({ baseUrl: '', fetch: fetchImpl }));
    expect(await api.requestOtp('+905321234567')).toEqual({ ok: false, error: { kind: 'server' } });
    expect(seen).toEqual([]);
  });

  it('every wire error code maps to a client error, and every route is versioned', () => {
    for (const code of API_ERROR_CODES) expect(toClientError({ code, message: '' }).kind).toBeTruthy();
    const routes = Object.values(ROUTES).map((r) => (typeof r === 'function' ? r('x') : r));
    expect(routes.every((r) => r.path.startsWith('/v1/'))).toBe(true);
  });
});

describe('account endpoints', () => {
  it('sign out revokes the session; account deletion sends the explicit confirmation', async () => {
    const { seen, fetchImpl } = fakeFetch((s) => ({ status: 200, json: s.url.endsWith('/deletion') ? { deletionRequested: true } : { signedOut: true } }));
    const admission = createHttpAdmissionApi(createHttpClient({ baseUrl: 'https://api.example.com', fetch: fetchImpl }));
    expect(await admission.signOut(session)).toEqual({ ok: true, value: undefined });
    expect(await admission.requestAccountDeletion(session)).toEqual({ ok: true, value: { deletionRequested: true } });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST https://api.example.com/v1/auth/sign-out', 'POST https://api.example.com/v1/me/deletion']);
    expect(seen.every((s) => s.headers.Authorization === 'Bearer tok_abc')).toBe(true);
    expect(seen[1]!.body).toEqual({ confirm: true });
  });

  it('a failed deletion maps to a typed error (the app keeps the person signed in)', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'x', retryAfterMs: 1000 } } }));
    const admission = createHttpAdmissionApi(createHttpClient({ baseUrl: 'https://api.example.com', fetch: fetchImpl }));
    const r = await admission.requestAccountDeletion(session);
    expect(r.ok).toBe(false);
  });
});

describe('backend selection', () => {
  it('release builds always use the HTTP backend; development defaults to the mock', () => {
    expect(resolveBackend({ appEnv: 'production', backend: 'mock', apiUrl: 'https://api.example.com' })).toEqual({ kind: 'http', apiUrl: 'https://api.example.com' });
    expect(resolveBackend({ appEnv: 'production', backend: undefined, apiUrl: undefined })).toEqual({ kind: 'http', apiUrl: '' });
    expect(resolveBackend({ appEnv: undefined, backend: undefined, apiUrl: undefined }).kind).toBe('mock');
    expect(resolveBackend({ appEnv: 'development', backend: 'http', apiUrl: 'http://127.0.0.1:8787' })).toEqual({ kind: 'http', apiUrl: 'http://127.0.0.1:8787' });
  });
});
