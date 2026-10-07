/**
 * Security suite (PART N, docs/SECURITY_MODEL.md). The declared policy of
 * EVERY endpoint is exercised from the registry — not a hand-picked list:
 * unauthenticated access, applicants on member routes, member sessions on
 * internal routes. Plus: signed internal requests (scope, signature,
 * timestamp, replay, tampering), injection and malformed input, oversized
 * bodies, horizontal access, safe errors, request ids, health, rate limits
 * shared across instances, log redaction.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES, type Route } from '@/services/api/contract';
import { TEST_ONLY_SCOPES } from '../src/config';
import { createApp, servedEndpoints } from '../src/http/app';
import { ENDPOINTS, type EndpointId, type EndpointPolicy } from '../src/http/endpoints';
import { errorResponse } from '../src/http/errors';
import { signInternalRequest } from '../src/http/internalAuth';
import { renderEndpointMatrix } from '../src/http/securityMatrix';
import { maskPhones, memoryLogger, redact } from '../src/lib/log';
import { createServices } from '../src/services';
import { activeMember, applicantInFinalReview, INTERNAL_KEYS, jpegBytesWithExif, signIn, testServer, upload, type T } from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer();
});
afterAll(async () => t.close());

const ENTRIES = Object.entries(ENDPOINTS) as [EndpointId, EndpointPolicy][];
const concrete = (p: string) => p.replace(/:mediaId/g, 'med_00000000000000000000').replace(/:id/g, 'id_00000000000000000000');

/** A body that passes input validation, so the policy (not validation) answers. */
const VALID_BODY: Partial<Record<EndpointId, unknown>> = {
  'member.react': { type: 'LIKE' },
  'member.sendMessage': { body: 'Merhaba', clientMessageId: 'c1' },
  'member.report': { reason: 'OTHER', context: 'profile' },
  'member.updateProfile': { occupation: 'Architect' },
  'member.saveDatingSettings': { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 25, max: 40 } },
  'media.createUpload': { mediaClass: 'PROFILE_MEDIA', contentType: 'image/jpeg', byteLength: 1000 },
  'account.requestDeletion': { confirm: true },
};

describe('the policy registry', () => {
  it('every app route in the shared contract is declared with a policy (same method and path)', () => {
    const declared = new Set(ENTRIES.map(([, p]) => `${p.method} ${p.path}`));
    const routes = Object.values(ROUTES).map((r) => (typeof r === 'function' ? (r as (id: string) => Route)(':id') : r));
    for (const r of routes) expect(declared.has(`${r.method} ${decodeURIComponent(r.path)}`), `${r.method} ${r.path}`).toBe(true);
  });

  it('every internal endpoint names a scope; every session endpoint declares a membership requirement', () => {
    for (const [id, p] of ENTRIES) {
      if (p.auth === 'internal') expect(p.scope, id).toBeTruthy();
      if (p.path.startsWith('/internal/')) expect(p.auth, id).toBe('internal');
      if (p.auth === 'session') expect(p.membership, id).not.toBe('NONE');
      expect(p.ownership.length && p.authorization.length && p.validation.length && p.response.length, id).toBeTruthy();
    }
  });

  it('docs/SECURITY_MODEL.md carries the generated endpoint table, unchanged', () => {
    const doc = readFileSync(join(__dirname, '../../docs/SECURITY_MODEL.md'), 'utf8');
    expect(doc).toContain(renderEndpointMatrix());
  });

  it('test-only and local-storage endpoints are absent where they must be', async () => {
    const prodLike = { config: { ...t.config, appEnv: 'production' as const }, store: { ...t.store, driver: 's3' as const } };
    const served = servedEndpoints(prodLike as never);
    expect(served).not.toContain('internal.testOtp');
    expect(served).not.toContain('internal.testReview');
    // Every test-only scope's endpoint is absent in production.
    for (const [id, policy] of Object.entries(ENDPOINTS) as [EndpointId, EndpointPolicy][]) {
      if (policy.scope && TEST_ONLY_SCOPES.includes(policy.scope)) expect(served, id).not.toContain(id);
    }
    expect(served).not.toContain('storage.upload');
    expect(served).not.toContain('storage.object');
    const app = createApp({ ...t.services, config: prodLike.config, store: prodLike.store } as never);
    expect((await app.request('/internal/test/otp', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/internal/test/applications/app_x/review', { method: 'POST' })).status).toBe(404);
    expect(served).not.toContain('internal.invitedMembership');
    expect((await app.request('/internal/reviewer/applications/app_x/invited-membership', { method: 'POST' })).status).toBe(404);
    // The read side of review is not test-only: production review needs it too.
    expect(served).toContain('internal.reviewQueue');
    expect(served).toContain('internal.reviewApplication');
    expect((await app.request('/v1/storage/object?b=media&k=x')).status).toBe(404);
  });
});

describe('authentication, from the registry', () => {
  it('every session endpoint refuses a missing, malformed or unknown token', async () => {
    for (const [id, p] of ENTRIES.filter(([, p]) => p.auth === 'session')) {
      for (const token of [undefined, 'x', 'A'.repeat(43)]) {
        const r = await t.request(p.method, concrete(p.path), { token, body: p.method === 'GET' ? undefined : VALID_BODY[id] });
        expect(r.status, `${id} ${token}`).toBe(401);
        expect(r.body.error.code, id).toBe('UNAUTHENTICATED');
      }
    }
  });

  it('every ACTIVE_MEMBER endpoint refuses an applicant', async () => {
    const ap = await applicantInFinalReview(t);
    for (const [id, p] of ENTRIES.filter(([, p]) => p.membership === 'ACTIVE_MEMBER')) {
      const r = await t.request(p.method, concrete(p.path), { token: ap.token, body: p.method === 'GET' ? undefined : (VALID_BODY[id] ?? {}) });
      expect(r.status, id).toBe(403);
      expect(r.body.error.code, id).toBe('MEMBERSHIP_REQUIRED');
    }
    // PROFILE_MEDIA uploads too (BY_MEDIA_CLASS).
    expect((await t.request('POST', '/v1/media/uploads', { token: ap.token, body: VALID_BODY['media.createUpload'] })).body.error.code).toBe('MEMBERSHIP_REQUIRED');
  });

  it('every internal endpoint refuses member sessions, unsigned calls and signatures without the scope', async () => {
    const m = await activeMember(t);
    for (const [id, p] of ENTRIES.filter(([, p]) => p.auth === 'internal')) {
      const path = concrete(p.path);
      const body = p.method === 'GET' ? undefined : {};
      expect((await t.request(p.method, path, { token: m.token, body })).status, id).toBe(401);
      expect((await t.request(p.method, path, { body })).status, id).toBe(401);
      // The reviewer key holds review:write only.
      const scoped = await t.internal(p.method, path, body, { keyId: 'reviewer' });
      // review:write passes authentication and reaches validation; every other scope is refused.
      expect(scoped.status, id).toBe(p.scope === 'review:write' ? 422 : 401);
    }
  });
});

describe('signed internal requests', () => {
  const path = '/internal/retention/run';
  const sign = (o: Partial<Parameters<typeof signInternalRequest>[0]> = {}) =>
    signInternalRequest({ env: 'test', keyId: 'ops', secret: INTERNAL_KEYS.ops.secret, method: 'POST', pathAndQuery: path, body: '', now: t.clock.now(), ...o });

  it('accept a valid signature exactly once', async () => {
    const headers = sign();
    expect((await t.request('POST', path, { headers })).status).toBe(200);
    const replay = await t.request('POST', path, { headers });
    expect(replay.status).toBe(401);
    expect(t.logLines.some((l) => l.includes('"reason":"REPLAY"'))).toBe(true);
  });

  it('refuse a wrong secret, an unknown key, a stale or future timestamp, a tampered body, method or path', async () => {
    const cases: [string, Record<string, string>, { method?: string; path?: string; body?: string }][] = [
      ['wrong secret', sign({ secret: 'x'.repeat(48) }), {}],
      ['unknown key', sign({ keyId: 'nobody' }), {}],
      ['stale', sign({ now: new Date(t.clock.now().getTime() - 6 * 60_000) }), {}],
      ['future', sign({ now: new Date(t.clock.now().getTime() + 6 * 60_000) }), {}],
      ['body', sign({ body: '{"a":1}' }), { body: '{"a":2}' }],
      ['path', sign({ pathAndQuery: '/internal/retention/run?x=1' }), {}],
      ['method', sign({ method: 'GET' }), {}],
      ['another environment', sign({ env: 'staging' }), {}],
      ['malformed', { 'x-internal-key-id': 'ops', 'x-internal-timestamp': 'soon', 'x-internal-nonce': 'n', 'x-internal-signature': 'x' }, {}],
    ];
    for (const [name, headers, o] of cases) {
      const r = await t.request((o.method ?? 'POST') as string, o.path ?? path, { headers, rawBody: o.body ?? '' });
      expect(r.status, name).toBe(401);
      expect(r.body.error.code, name).toBe('UNAUTHENTICATED');
    }
  });

  it('with INTERNAL_ALLOWED_CIDRS, a valid signature from outside the ranges is refused; a spoofed forwarded address does not help', async () => {
    const n = await testServer(undefined, { INTERNAL_ALLOWED_CIDRS: '10.9.0.0/16', TRUST_PROXY_HOPS: '1' });
    try {
      const signed = () =>
        signInternalRequest({ env: 'test', keyId: 'ops', secret: INTERNAL_KEYS.ops.secret, method: 'POST', pathAndQuery: path, body: '', now: n.clock.now() });
      const outside = await n.request('POST', path, { headers: { ...signed(), 'x-forwarded-for': '203.0.113.9' } });
      expect(outside.status).toBe(401);
      expect(n.logLines.some((l) => l.includes('"reason":"NETWORK"'))).toBe(true);
      // The client prepends an allowed address; our proxy appends the real one, which is what counts.
      const spoofed = await n.request('POST', path, { headers: { ...signed(), 'x-forwarded-for': '10.9.1.1, 203.0.113.9' } });
      expect(spoofed.status).toBe(401);
      const inside = await n.request('POST', path, { headers: { ...signed(), 'x-forwarded-for': '10.9.4.2' } });
      expect(inside.status).toBe(200);
      // Inside the range, the signature is still required.
      expect((await n.request('POST', path, { headers: { 'x-forwarded-for': '10.9.4.2' } })).status).toBe(401);
    } finally {
      await n.close();
    }
  });
});

describe('hostile input', () => {
  it('SQL injection attempts are inert: typed answers, no database text, tables intact', async () => {
    const m = await activeMember(t);
    const payloads = [`' OR 1=1 --`, `x'; DROP TABLE app.accounts; --`, `") UNION SELECT phone_e164 FROM app.accounts --`, '%27%20OR%201%3D1'];
    for (const x of payloads) {
      for (const p of [`/v1/members/${encodeURIComponent(x)}`, `/v1/matches/${encodeURIComponent(x)}`]) {
        const r = await t.request('GET', p, { token: m.token });
        expect([404]).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toMatch(/SELECT|syntax|relation|app\.|pg_|\+90/i);
      }
      const react = await t.request('POST', `/v1/introductions/${encodeURIComponent(x)}/reaction`, { token: m.token, body: { type: 'LIKE' } });
      expect(react.body.error.code).toBe('INTRODUCTION_NOT_FOUND');
      expect((await t.request('POST', '/v1/auth/otp', { body: { phoneE164: x } })).body.error.code).toBe('INVALID_PHONE');
      const rep = await t.request('POST', `/v1/members/${m.memberId}/reports`, { token: m.token, body: { reason: x, context: 'profile' } });
      expect(rep.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.accounts')).rows[0].n).toBeGreaterThan(0);
  });

  it('malformed JSON and wrong JSON shapes are validation errors, never server errors', async () => {
    const s = await signIn(t);
    for (const raw of ['{nope', '[]', 'null', '"text"', '42', '{"phoneE164":{"$gt":""}}']) {
      const r = await t.request('POST', '/v1/auth/otp', { rawBody: raw });
      expect(r.status, raw).toBeLessThan(500);
      expect(['VALIDATION_FAILED', 'INVALID_PHONE'], raw).toContain(r.body.error.code);
      const a = await t.request('POST', '/v1/application', { token: s.token, rawBody: raw, headers: { 'Idempotency-Key': `k${raw.length}` } });
      expect(a.status, raw).toBe(422);
    }
  });

  it('oversized bodies are refused before they are read', async () => {
    const big = JSON.stringify({ phoneE164: '+905321234567', pad: 'x'.repeat(70 * 1024) });
    const r = await t.request('POST', '/v1/auth/otp', { rawBody: big });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    // The rest of the body may still be on its way: the connection is closed rather than reused.
    expect(r.headers?.get('connection')).toBe('close');
    const s = await signIn(t);
    expect((await t.request('POST', '/v1/me/deletion', { token: s.token, rawBody: big })).status).toBe(413);
  });
});

describe('horizontal access', () => {
  it('one member cannot reach another member’s introductions, matches, conversations, uploads or application', async () => {
    const W = { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 25, max: 45 } } as const;
    const M = { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 25, max: 45 } } as const;
    const w = await activeMember(t, { firstName: 'Selin', dating: { ...W, seeking: [...W.seeking] } });
    const m = await activeMember(t, { firstName: 'Mert', dateOfBirth: '1992-02-11', dating: { ...M, seeking: [...M.seeking] } });
    const x = await activeMember(t, { firstName: 'Ece', dating: { ...W, seeking: [...W.seeking] } });
    const mi = (await t.request('GET', '/v1/introductions/today', { token: m.token })).body.waiting.find((e: { member: { memberId: string } }) => e.member.memberId === w.memberId).introductionId;
    const wi = (await t.request('GET', '/v1/introductions/today', { token: w.token })).body.waiting[0].introductionId;
    await t.request('POST', `/v1/introductions/${mi}/reaction`, { token: m.token, body: { type: 'LIKE' } });
    const match = await t.request('POST', `/v1/introductions/${wi}/reaction`, { token: w.token, body: { type: 'LIKE' } });
    const conv = await t.request('POST', `/v1/matches/${match.body.match.matchId}/conversation`, { token: w.token });
    // x (a member, not part of it):
    expect((await t.request('POST', `/v1/introductions/${wi}/reaction`, { token: x.token, body: { type: 'LIKE' } })).body.error.code).toBe('INTRODUCTION_NOT_FOUND');
    expect((await t.request('GET', `/v1/matches/${match.body.match.matchId}`, { token: x.token })).body.error.code).toBe('MATCH_NOT_FOUND');
    expect((await t.request('POST', `/v1/matches/${match.body.match.matchId}/conversation`, { token: x.token })).body.error.code).toBe('MATCH_NOT_FOUND');
    expect(
      (await t.request('POST', `/v1/conversations/${conv.body.conversationId}/messages`, { token: x.token, body: { body: 'hi', clientMessageId: 'x1' } })).body.error.code,
    ).toBe('CONVERSATION_FORBIDDEN');
    expect((await t.request('GET', `/v1/members/${w.memberId}`, { token: x.token })).body.error.code).toBe('NOT_AVAILABLE');
    // Uploads are bound to the account that created them.
    const up = await t.request('POST', '/v1/media/uploads', { token: w.token, body: { mediaClass: 'PROFILE_MEDIA', contentType: 'image/jpeg', byteLength: 500 } });
    expect((await t.request('POST', `/v1/media/uploads/${up.body.uploadId}/complete`, { token: x.token })).body.error.code).toBe('NOT_FOUND');
    // Applicants: another application's information request.
    const a1 = await applicantInFinalReview(t);
    const a2 = await applicantInFinalReview(t);
    await t.internal('POST', `/internal/reviewer/applications/${a1.applicationId}/actions`, { reviewerId: 'r.one', action: { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'INSTAGRAM_NOT_FOUND' }] } });
    await t.internal('POST', `/internal/reviewer/applications/${a2.applicationId}/actions`, { reviewerId: 'r.one', action: { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'INSTAGRAM_NOT_FOUND' }] } });
    const req1 = (await t.request('GET', '/v1/me/application', { token: a1.token })).body.informationRequests[0].id;
    const r = await t.request('PUT', `/v1/application/information-requests/${req1}/response`, { token: a2.token, body: { type: 'UPDATE_INSTAGRAM', handle: '@hijack' } });
    expect(r.body.error.code).toBe('NOT_ALLOWED');
    expect((await t.pool.query('SELECT response FROM app.information_requests WHERE id = $1', [req1])).rows[0].response).toBeNull();
  });

  it('signed media urls bind bucket, key and expiry: switching bucket or class fails', async () => {
    const ap = await applicantInFinalReview(t);
    await t.internal('POST', `/internal/reviewer/applications/${ap.applicationId}/actions`, {
      reviewerId: 'r.one',
      action: { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: ap.photoIds[0] }, { preset: 'CONFIRM_IDENTITY' }] },
    });
    const reqs = (await t.request('GET', '/v1/me/application', { token: ap.token })).body.informationRequests;
    const verify = reqs.find((r: { type: string }) => r.type === 'VERIFY_IDENTITY');
    const v = await upload(t, ap.token, await jpegBytesWithExif(2), { requestId: verify.id, mediaClass: 'VERIFICATION_MEDIA' });
    const reviewer = await t.internal('POST', `/internal/reviewer/applications/${ap.applicationId}/media/${v.body.mediaId}/access`, { reviewerId: 'r.one', purpose: 'REVIEW' });
    const url = new URL(reviewer.body.url);
    const switched = `${url.pathname}${url.search.replace('b=verification', 'b=media')}`;
    expect((await t.app.request(switched)).status).toBe(404);
    // An applicant url cannot be bent to the verification object either.
    const photoUrl = new URL(reqs.find((r: { type: string }) => r.type === 'REPLACE_PHOTO').current.uri);
    const bent = `${photoUrl.pathname}${photoUrl.search.replace(/k=[^&]+/, `k=${encodeURIComponent(url.searchParams.get('k')!)}`).replace('b=media', 'b=verification')}`;
    expect((await t.app.request(bent)).status).toBe(404);
  });
});

describe('safe errors and observability', () => {
  it('an unexpected failure answers a generic INTERNAL with a request id; the detail goes to the server log only', async () => {
    const m = await activeMember(t);
    const w = await activeMember(t, { firstName: 'Lale' });
    // m has blocked w (so may report her) — the report then hits a table that is not there.
    await t.pool.query('INSERT INTO app.blocks (id, blocker_id, blocked_id, created_at) VALUES ($1, $2, $3, now())', ['blk_sec', m.memberId, w.memberId]);
    await t.admin.query('ALTER TABLE app.reports RENAME TO reports_moved');
    try {
      const fail = await t.request('POST', `/v1/members/${w.memberId}/reports`, { token: m.token, body: { reason: 'OTHER', context: 'profile' } });
      expect(fail.status).toBe(500);
      expect(fail.body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId: expect.stringMatching(/^req_/) } });
      const text = JSON.stringify(fail.body);
      expect(text).not.toMatch(/reports|relation|SELECT|INSERT|\/home|\.ts|at /);
      const line = t.logLines.map((l) => JSON.parse(l)).find((l) => l.event === 'request.failed' && l.requestId === fail.body.error.requestId);
      expect(line).toMatchObject({ level: 'error', dbCode: '42P01', route: '/v1/members/:id/reports' });
      expect(line.stack).toBeTruthy();
    } finally {
      await t.admin.query('ALTER TABLE app.reports_moved RENAME TO reports');
    }
    expect(errorResponse(new Error('duplicate key value violates unique constraint "accounts_phone_e164_key" (+905321234567)')).body.error).toEqual({
      code: 'INTERNAL',
      message: 'Something went wrong. Please try again.',
    });
  });

  it('every response carries X-Request-Id; a well-formed inbound id is kept, anything else replaced', async () => {
    const a = await t.app.request('/health/live');
    expect(a.headers.get('x-request-id')).toMatch(/^req_[A-Za-z0-9_-]{12}$/);
    const b = await t.app.request('/health/live', { headers: { 'x-request-id': 'edge-1234abcd' } });
    expect(b.headers.get('x-request-id')).toBe('edge-1234abcd');
    const c = await t.app.request('/health/live', { headers: { 'x-request-id': '<script>' } });
    expect(c.headers.get('x-request-id')).toMatch(/^req_/);
  });

  it('logs redact secrets and personal data by key, and mask phone numbers in free text', () => {
    const out = redact({
      phoneE164: '+905321234567',
      code: '123456',
      token: 'abc',
      authorization: 'Bearer x',
      nested: { dateOfBirth: '1990-01-01', seeking: ['MAN'], notes: 'reviewer note', url: 'https://x/sig' },
      message: 'failed for +90 532 123 45 67',
      count: 3,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      phoneE164: '[redacted]',
      code: '[redacted]',
      token: '[redacted]',
      authorization: '[redacted]',
      nested: { dateOfBirth: '[redacted]', seeking: '[redacted]', notes: '[redacted]', url: '[redacted]' },
      message: 'failed for •••67',
      count: 3,
    });
    expect(maskPhones('+905321234567')).toBe('•••67');
    // A provider job id (longer than any phone number) is kept for tracing; anything phone-sized is still masked.
    expect(redact({ providerRef: '17377215342605050417149344' })).toEqual({ providerRef: '17377215342605050417149344' });
    expect(redact({ providerRef: '905321234567' })).toEqual({ providerRef: '•••67' });
    expect(redact({ providerRef: '+905321234567000000' })).toEqual({ providerRef: '•••00' });
    const { logger, lines } = memoryLogger();
    logger.info('x', { phone: '+905321234567', otp: '654321' });
    expect(lines.join()).not.toMatch(/5321234567|654321/);
  });

  it('no request body, token or code ever reaches the log', async () => {
    const s = await signIn(t);
    const all = t.logLines.join('\n');
    expect(all).not.toContain(s.token);
    expect(all).not.toContain(s.phone);
    expect(all).not.toContain(t.sms.last(s.phone)!);
  });
});

describe('health', () => {
  it('live and ready answer without private data; ready reflects the database schema', async () => {
    expect(await (await t.app.request('/health/live')).json()).toEqual({ status: 'ok' });
    const ready = await t.app.request('/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok', storage: 'ok' } });
    // A newer release's migration applied while this instance still serves (rollout): still ready.
    await t.admin.query(`INSERT INTO app_meta.schema_migrations (version, checksum) VALUES ('9999_from_the_future.sql', 'x')`);
    try {
      const ahead = await t.app.request('/health/ready');
      expect(ahead.status).toBe(200);
      expect(await ahead.json()).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ahead', storage: 'ok' } });
    } finally {
      await t.admin.query(`DELETE FROM app_meta.schema_migrations WHERE version = '9999_from_the_future.sql'`);
    }
    // A migration of THIS build missing (the release step did not run): not ready.
    const last = (await t.admin.query(`SELECT version, checksum, applied_at FROM app_meta.schema_migrations ORDER BY version DESC LIMIT 1`)).rows[0];
    await t.admin.query(`DELETE FROM app_meta.schema_migrations WHERE version = $1`, [last.version]);
    try {
      const behind = await t.app.request('/health/ready');
      expect(behind.status).toBe(503);
      expect(await behind.json()).toEqual({ status: 'not_ready', checks: { database: 'ok', migrations: 'mismatch', storage: 'ok' } });
    } finally {
      await t.admin.query(`INSERT INTO app_meta.schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)`, [last.version, last.checksum, last.applied_at]);
    }
  });
});

describe('rate limits live in the database, not in one process', () => {
  it('two API instances share the same counters', async () => {
    const { logger } = memoryLogger();
    const second = createApp(createServices({ pool: t.pool, config: t.config, clock: t.services.clock, log: logger, sms: t.sms, store: t.store }));
    const ip = '198.51.100.7';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const app = i % 2 === 0 ? t.app : second;
      const r = await app.request('/v1/auth/otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ phoneE164: `+90532${String(7_000_000 + i)}` }),
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429); // the 31st from this address within the hour, whichever instance serves it
  });
});
