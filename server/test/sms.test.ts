/**
 * SMS provider boundary (DEC-061, docs/SMS_PROVIDER.md): the Netgsm adapter
 * against a fake vendor (HTTP), failure classification and the safe client
 * answer, routing by country, and staging test numbers read through the
 * signed internal test endpoint.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETGSM_FAILURES, netgsmDeliveryReport, netgsmSms, routeSms, SmsDeliveryError, type SmsFailure } from '../src/auth/sms';
import { loadConfig } from '../src/config';
import { smsFor } from '../src/compose';
import { testServer } from './harness';

type Received = { url: string; contentType: string; authorization: string; body: string };

/** A stand-in for Netgsm's REST API: records requests, answers with a programmable code. */
function fakeVendor() {
  const received: Received[] = [];
  const replies: { status?: number; code?: string; delayMs?: number; raw?: string }[] = [];
  const reports: { code: string; jobs: unknown[] | null }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', contentType: req.headers['content-type'] ?? '', authorization: req.headers.authorization ?? '', body });
      if (req.url === '/sms/rest/v2/report') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reports.shift() ?? { code: '60', jobs: null, description: 'no record' }));
        return;
      }
      const r = replies.shift() ?? { code: '00' };
      const answer = () => {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(r.raw ?? JSON.stringify(r.code === '00' ? { jobid: '17377215342605050417149344', code: '00', description: 'success' } : { code: r.code, description: 'x' }));
      };
      if (r.delayMs) setTimeout(answer, r.delayMs);
      else answer();
    });
  });
  return {
    received,
    replies,
    reports,
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    codeIn: (body: string) => /\b(\d{6})\b/.exec((JSON.parse(body) as { msg: string }).msg)?.[1] ?? null,
  };
}

const vendor = fakeVendor();
let baseUrl = '';
beforeAll(async () => {
  baseUrl = await vendor.start();
});
afterAll(async () => vendor.stop());

const adapter = (over: Partial<Parameters<typeof netgsmSms>[0]> = {}) =>
  netgsmSms({ baseUrl, usercode: '8501234567', password: 'p&ss:word', header: 'VELVET', template: 'Your code is {code}.', ...over });

describe('Netgsm adapter (REST v2)', () => {
  it('posts the OTP JSON with Basic auth (API sub-user), the national number and the code; answers the job id', async () => {
    vendor.received.length = 0;
    const receipt = await adapter().sendVerificationCode({ phoneE164: '+905321234567', code: '048213' });
    expect(receipt).toEqual({ providerRef: '17377215342605050417149344' });
    const r = vendor.received[0]!;
    expect(r.url).toBe('/sms/rest/v2/otp');
    expect(r.contentType).toMatch(/application\/json/);
    expect(r.authorization).toBe(`Basic ${Buffer.from('8501234567:p&ss:word').toString('base64')}`);
    expect(JSON.parse(r.body)).toEqual({ msgheader: 'VELVET', msg: 'Your code is 048213.', no: '5321234567' });
  });

  it('classifies vendor failures; refuses non-Türkiye numbers without calling the vendor', async () => {
    const outcome = async (reply: { status?: number; code?: string; delayMs?: number; raw?: string }, timeoutMs?: number): Promise<SmsFailure | 'ok'> => {
      vendor.replies.push(reply);
      try {
        await adapter({ timeoutMs }).sendVerificationCode({ phoneE164: '+905321234567', code: '123456' });
        return 'ok';
      } catch (e) {
        return (e as SmsDeliveryError).failure;
      }
    };
    for (const [code, failure] of Object.entries(NETGSM_FAILURES)) expect(await outcome({ code }), code).toBe(failure);
    expect(await outcome({ code: '99' })).toBe('PROVIDER_UNAVAILABLE'); // unknown code: an outage, never success
    expect(await outcome({ status: 503, raw: 'Service Unavailable' })).toBe('PROVIDER_UNAVAILABLE');
    // Acceptance is the code: a missing or numeric job id never turns a delivered code into an outage.
    expect(await outcome({ raw: '{"code":"00"}' })).toBe('ok');
    expect(await outcome({ raw: '{"code":"00","jobid":17377215342605}' })).toBe('ok');
    expect(await outcome({ raw: '{"code":0}' })).toBe('PROVIDER_UNAVAILABLE'); // "0" is not Netgsm's success code
    expect(await outcome({ raw: '<html>' })).toBe('PROVIDER_UNAVAILABLE');
    expect(await outcome({ delayMs: 300 }, 50)).toBe('PROVIDER_UNAVAILABLE');
    const before = vendor.received.length;
    await expect(adapter().sendVerificationCode({ phoneE164: '+447700900123', code: '123456' })).rejects.toMatchObject({ failure: 'INVALID_PHONE' });
    expect(vendor.received.length).toBe(before);
    await expect(adapter({ baseUrl: 'http://127.0.0.1:1' }).sendVerificationCode({ phoneE164: '+905321234567', code: '1' })).rejects.toMatchObject({
      failure: 'PROVIDER_UNAVAILABLE',
      detail: 'network',
    });
  });

  it('routes by country: +90 to Netgsm, anything else fails closed', async () => {
    const routed = routeSms({ '+90': adapter() });
    await expect(routed.sendVerificationCode({ phoneE164: '+4915112345678', code: '123456' })).rejects.toMatchObject({ failure: 'NOT_CONFIGURED' });
    expect(await routed.sendVerificationCode({ phoneE164: '+905321234567', code: '123456' })).toEqual({ providerRef: expect.any(String) });
  });

  it('reads delivery reports by job id (ops tooling): delivered, pending, failed', async () => {
    vendor.reports.push({
      code: '00',
      jobs: [
        { jobid: 'a', number: '532xxxxxxx', status: 1, operator: 30, msglen: 1, deliveredDate: '2026-10-07 10:00:01', errorCode: 0 },
        { jobid: 'b', status: 0, errorCode: 0 },
        { jobid: 'c', status: 3, errorCode: 105 },
      ],
    });
    const report = await netgsmDeliveryReport({ baseUrl, usercode: 'u', password: 'p' }, ['a', 'b', 'c']);
    expect(report).toEqual([
      { jobId: 'a', state: 'DELIVERED', status: 1, errorCode: null, deliveredAt: '2026-10-07 10:00:01' },
      { jobId: 'b', state: 'PENDING', status: 0, errorCode: null, deliveredAt: null },
      { jobId: 'c', state: 'FAILED', status: 3, errorCode: 105, deliveredAt: null },
    ]);
    expect(JSON.parse(vendor.received.at(-1)!.body)).toEqual({ jobids: ['a', 'b', 'c'] });
    await expect(netgsmDeliveryReport({ baseUrl, usercode: 'u', password: 'p' }, ['x'])).rejects.toMatchObject({ failure: 'PROVIDER_UNAVAILABLE' });
  });

  it('configuration refuses an OTP template Netgsm cannot send as one ASCII segment', () => {
    const env = { APP_ENV: 'test', DATABASE_URL: 'postgres://x@y/z', SMS_PROVIDER: 'netgsm', NETGSM_USERCODE: 'u', NETGSM_PASSWORD: 'p', NETGSM_HEADER: 'H' };
    expect(() => loadConfig({ ...env, SMS_OTP_TEMPLATE: 'Doğrulama kodunuz {code}' })).toThrow(/printable ASCII/);
    expect(() => loadConfig({ ...env, SMS_OTP_TEMPLATE: `${'x'.repeat(150)} {code}` })).toThrow(/155/);
    expect(() => loadConfig(env)).not.toThrow();
  });
});

describe('through the API', () => {
  it('a code reaches the vendor and signs in; failures become a safe, retryable answer; logs carry the class, never the number or code', async () => {
    const t = await testServer(
      undefined,
      { SMS_PROVIDER: 'netgsm', NETGSM_USERCODE: 'u', NETGSM_PASSWORD: 'p', NETGSM_HEADER: 'VELVET', NETGSM_BASE_URL: baseUrl },
      { sms: ({ pool, config, clock }) => smsFor(config, pool, clock) },
    );
    try {
      vendor.received.length = 0;
      const otp = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+905321110000' } });
      expect(otp.status).toBe(200);
      const code = vendor.codeIn(vendor.received[0]!.body)!;
      const v = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code } });
      expect(v.status).toBe(200);

      vendor.replies.push({ code: '100' });
      const limited = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+905321110001' } });
      expect(limited.status).toBe(503);
      expect(limited.body.error).toMatchObject({ code: 'CODE_NOT_SENT', message: 'We couldn’t send a code right now. Try again.' });
      expect(JSON.stringify(limited.body)).not.toMatch(/netgsm|100|PROVIDER|vendor/i);
      vendor.replies.push({ code: '50' });
      expect((await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+905321110002' } })).body.error.code).toBe('INVALID_PHONE');
      expect((await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+4915112345678' } })).body.error.code).toBe('CODE_NOT_SENT');
      // The undelivered challenge cannot be used.
      const consumed = await t.pool.query(`SELECT count(*)::int AS n FROM app.otp_challenges WHERE phone_e164 = '+905321110001' AND consumed_at IS NULL`);
      expect(consumed.rows[0].n).toBe(0);
      const logs = t.logLines.filter((l) => l.includes('sms.send_failed')).map((l) => JSON.parse(l));
      expect(logs.map((l) => l.failure)).toEqual(['PROVIDER_UNAVAILABLE', 'INVALID_PHONE', 'NOT_CONFIGURED']);
      // The accepted send is traceable by the provider's job id — never by number or code.
      expect(t.logLines.some((l) => l.includes('"otp.sent"') && l.includes('17377215342605050417149344'))).toBe(true);
      expect(logs.every((l) => typeof l.requestId === 'string')).toBe(true);
      const all = t.logLines.join('\n');
      expect(all).not.toContain('5321110001');
      expect(all).not.toContain(code);
    } finally {
      await t.close();
    }
  });

  it('staging test numbers: the code goes to the internal outbox, readable once with the test:otp scope only', async () => {
    const t = await testServer(
      undefined,
      { SMS_PROVIDER: 'netgsm', NETGSM_USERCODE: 'u', NETGSM_PASSWORD: 'p', NETGSM_HEADER: 'VELVET', NETGSM_BASE_URL: baseUrl, SMS_TEST_NUMBERS: '+90555000*' },
      { sms: ({ pool, config, clock }) => smsFor(config, pool, clock) },
    );
    try {
      vendor.received.length = 0;
      const otp = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+905550001234' } });
      expect(otp.status).toBe(200);
      expect(vendor.received).toEqual([]); // never sent to a real phone
      expect((await t.internal('POST', '/internal/test/otp', { phoneE164: '+905550001234' }, { keyId: 'reviewer' })).status).toBe(401);
      const read = await t.internal('POST', '/internal/test/otp', { phoneE164: '+905550001234' });
      expect(read.body.code).toMatch(/^\d{6}$/);
      expect((await t.internal('POST', '/internal/test/otp', { phoneE164: '+905550001234' })).status).toBe(404); // once
      expect((await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code: read.body.code } })).status).toBe(200);
      // Real numbers are never readable.
      await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+905321112233' } });
      expect(vendor.received).toHaveLength(1);
      expect((await t.internal('POST', '/internal/test/otp', { phoneE164: '+905321112233' })).status).toBe(404);
    } finally {
      await t.close();
    }
  });
});
