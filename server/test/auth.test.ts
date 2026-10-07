/** Authentication: phone → OTP → session. No fixed code; limits; sessions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextPhone, signIn, testServer, type T } from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer();
});
afterAll(async () => t.close());

describe('one-time codes', () => {
  it('issues a random six-digit code, delivered by the SMS sender and stored only as a keyed hash', async () => {
    const phone = nextPhone();
    const r = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['challengeId', 'expiresAt', 'phoneE164', 'resendAvailableAt']);
    const code = t.sms.last(phone)!;
    expect(code).toMatch(/^\d{6}$/);
    const { rows } = await t.pool.query('SELECT code_hash FROM app.otp_challenges WHERE id = $1', [r.body.challengeId]);
    expect(rows[0].code_hash).not.toContain(code);
    expect(JSON.stringify(r.body)).not.toContain(code);
  });

  it('has no fixed development code: the mock code never works, codes differ between challenges', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const phone = nextPhone();
      const r = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
      codes.add(t.sms.last(phone)!);
      if (t.sms.last(phone) !== '246810') {
        const bad = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: r.body.challengeId, code: '246810' } });
        expect(bad.status).toBe(422);
        expect(bad.body.error.code).toBe('INVALID_CODE');
      }
    }
    expect(codes.size).toBeGreaterThan(1);
  });

  it('verifies once, creates the account once, and returns a session', async () => {
    const phone = nextPhone();
    const first = await signIn(t, phone);
    expect(first.token.length).toBeGreaterThan(30);
    t.clock.advanceDays(0.01);
    const again = await signIn(t, phone);
    expect(again.accountId).toBe(first.accountId);
    const { rows } = await t.pool.query('SELECT token_hash FROM app.sessions WHERE account_id = $1', [first.accountId]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.token_hash)).not.toContain(first.token);
    const audit = await t.pool.query(`SELECT event_type FROM app.audit_events WHERE account_id = $1`, [first.accountId]);
    expect(audit.rows.map((r) => r.event_type)).toEqual(['PHONE_VERIFIED']);
  });

  it('counts wrong attempts, then locks the challenge', async () => {
    const phone = nextPhone();
    const r = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    const right = t.sms.last(phone)!;
    const wrong = right === '000000' ? '111111' : '000000';
    const remaining: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: r.body.challengeId, code: wrong } });
      remaining.push(v.body.error.attemptsRemaining ?? -1);
      if (i === 4) expect(v.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    }
    expect(remaining.slice(0, 4)).toEqual([4, 3, 2, 1]);
    const late = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: r.body.challengeId, code: right } });
    expect(late.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('expires codes, consumes earlier challenges, enforces the resend cooldown and an hourly limit', async () => {
    const phone = nextPhone();
    const a = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    const soon = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    expect(soon.status).toBe(429);
    expect(soon.body.error.code).toBe('RATE_LIMITED');
    expect(soon.body.error.retryAfterMs).toBeGreaterThan(0);
    t.clock.set(new Date(t.clock.now().getTime() + 31_000).toISOString());
    const b = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    expect(b.status).toBe(200);
    // The first challenge was consumed by the second.
    const old = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: a.body.challengeId, code: '123456' } });
    expect(old.body.error.code).toBe('CODE_EXPIRED');
    t.clock.set(new Date(t.clock.now().getTime() + 11 * 60_000).toISOString());
    const expired = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: b.body.challengeId, code: t.sms.last(phone) } });
    expect(expired.body.error.code).toBe('CODE_EXPIRED');
    // At most five codes per number per hour.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      t.clock.set(new Date(t.clock.now().getTime() + 31_000).toISOString());
      statuses.push((await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('refuses malformed numbers', async () => {
    for (const phoneE164 of ['05321234567', '+90', 'x', 42, null]) {
      const r = await t.request('POST', '/v1/auth/otp', { body: { phoneE164 } });
      expect(r.body.error.code).toBe('INVALID_PHONE');
    }
  });
});

describe('one-time code security', () => {
  it('a code works once: replaying a successful verification is refused', async () => {
    const phone = nextPhone();
    const r = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    const body = { challengeId: r.body.challengeId, code: t.sms.last(phone) };
    expect((await t.request('POST', '/v1/auth/otp/verify', { body })).status).toBe(200);
    const replay = await t.request('POST', '/v1/auth/otp/verify', { body });
    expect(replay.body.error.code).toBe('CODE_EXPIRED');
    // Concurrent duplicates: exactly one session.
    t.clock.set(new Date(t.clock.now().getTime() + 31_000).toISOString());
    const r2 = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    const body2 = { challengeId: r2.body.challengeId, code: t.sms.last(phone) };
    const burst = await Promise.all(Array.from({ length: 5 }, () => t.request('POST', '/v1/auth/otp/verify', { body: body2 })));
    expect(burst.filter((x) => x.status === 200)).toHaveLength(1);
  });

  it('resists account enumeration: requests and wrong codes read the same for known and unknown numbers', async () => {
    const known = await signIn(t);
    t.clock.set(new Date(t.clock.now().getTime() + 31_000).toISOString());
    const unknown = nextPhone();
    const a = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: known.phone } });
    const b = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: unknown } });
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    const shape = (x: { challengeId: string; expiresAt: string; resendAvailableAt: string }) => [x.challengeId.slice(0, 4), x.expiresAt, x.resendAvailableAt];
    expect(shape(a.body)).toEqual(shape(b.body));
    const wa = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: a.body.challengeId, code: t.sms.last(known.phone) === '999999' ? '999998' : '999999' } });
    const wb = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: b.body.challengeId, code: t.sms.last(unknown) === '999999' ? '999998' : '999999' } });
    expect({ ...wa.body.error, requestId: null }).toEqual({ ...wb.body.error, requestId: null });
    // An invented challenge reads like an expired one.
    expect((await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: 'otp_invented', code: '123456' } })).body.error.code).toBe('CODE_EXPIRED');
  });

  it('limits verification attempts per number across challenges (not only per code)', async () => {
    const phone = nextPhone();
    const statuses: string[] = [];
    for (let c = 0; c < 5; c++) {
      t.clock.set(new Date(t.clock.now().getTime() + 31_000).toISOString());
      const r = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
      const wrong = t.sms.last(phone) === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) statuses.push((await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: r.body.challengeId, code: wrong } })).body.error.code);
    }
    expect(statuses.filter((x) => x === 'RATE_LIMITED')).toHaveLength(5); // attempts 21–25 within the hour
  });

  it('when the SMS cannot be sent, the client hears a safe retryable message and the challenge is unusable', async () => {
    const phone = nextPhone();
    t.sms.failNext('PROVIDER_UNAVAILABLE');
    const r = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    expect(r.status).toBe(503);
    expect(r.body.error).toEqual({ code: 'CODE_NOT_SENT', message: 'We couldn’t send a code right now. Try again.', requestId: expect.stringMatching(/^req_/) });
    const open = await t.pool.query('SELECT count(*)::int AS n FROM app.otp_challenges WHERE phone_e164 = $1 AND consumed_at IS NULL', [phone]);
    expect(open.rows[0].n).toBe(0);
    const line = t.logLines.map((l) => JSON.parse(l)).find((l) => l.event === 'sms.send_failed');
    expect(line).toMatchObject({ level: 'warn', provider: 'capture', failure: 'PROVIDER_UNAVAILABLE', requestId: r.body.error.requestId });
    expect(t.logLines.join('\n')).not.toContain(phone.slice(3));
  });

  it('validates verification input types', async () => {
    for (const body of [{}, { challengeId: 5, code: '123456' }, { challengeId: 'x'.repeat(101), code: '123456' }, { challengeId: 'otp_x', code: 123456 }]) {
      expect((await t.request('POST', '/v1/auth/otp/verify', { body })).body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('sessions', () => {
  it('require a valid bearer token; sign-out revokes it', async () => {
    const s = await signIn(t);
    expect((await t.request('GET', '/v1/me/application', { token: s.token })).status).toBe(200);
    expect((await t.request('GET', '/v1/me/application')).body.error.code).toBe('UNAUTHENTICATED');
    expect((await t.request('GET', '/v1/me/application', { token: 'x'.repeat(43) })).status).toBe(401);
    await t.request('POST', '/v1/auth/sign-out', { token: s.token });
    expect((await t.request('GET', '/v1/me/application', { token: s.token })).status).toBe(401);
  });

  it('internal endpoints never accept a member or applicant session', async () => {
    const s = await signIn(t);
    const r = await t.request('POST', '/internal/billing/payment-confirmed', { token: s.token, body: { accountId: s.accountId, providerEventId: 'e1', provider: 'x' } });
    expect(r.status).toBe(401);
  });
});
