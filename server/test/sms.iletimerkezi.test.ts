/**
 * İleti Merkezi adapter (DEC-085, docs/SMS_PROVIDER.md) against a fake vendor
 * speaking the documented JSON API: request shape, acceptance, every
 * documented status code, non-JSON, timeout, network — and the safe answer
 * the applicant gets through the API.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ILETIMERKEZI_FAILURES, iletimerkeziSms, SmsDeliveryError, type SmsFailure } from '../src/auth/sms';
import { loadConfig } from '../src/config';
import { smsFor } from '../src/compose';
import { testServer } from './harness';

type Reply = { http?: number; code?: string; orderId?: string | number | null; raw?: string; delayMs?: number };

function fakeIletiMerkezi() {
  const received: { url: string; body: string; contentType: string }[] = [];
  const replies: Reply[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body, contentType: req.headers['content-type'] ?? '' });
      const r = replies.shift() ?? { code: '200', orderId: '12323232' };
      const answer = () => {
        res.writeHead(r.http ?? (r.code === '200' || !r.code ? 200 : Number(r.code) < 600 ? Number(r.code) : 400), { 'content-type': 'application/json' });
        res.end(
          r.raw ??
            JSON.stringify({
              response: { status: { code: r.code ?? '200', message: 'x' }, ...(r.code === '200' && r.orderId !== null ? { order: { id: r.orderId ?? '12323232' } } : {}) },
            }),
        );
      };
      if (r.delayMs) setTimeout(answer, r.delayMs);
      else answer();
    });
  });
  return {
    received,
    replies,
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const vendor = fakeIletiMerkezi();
let baseUrl = '';
beforeAll(async () => {
  baseUrl = await vendor.start();
});
afterAll(async () => vendor.stop());

const adapter = (over: Partial<Parameters<typeof iletimerkeziSms>[0]> = {}) =>
  iletimerkeziSms({ baseUrl, apiKey: 'key-123', apiHash: 'hash-456', sender: 'VELVET', template: 'Your code is {code}.', ...over });

const failureOf = async (p: Promise<unknown>): Promise<SmsFailure | 'resolved'> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as SmsDeliveryError).failure;
  }
};

describe('İleti Merkezi adapter', () => {
  it('posts the documented JSON (key + hash, sender, iys 0, the national number) and returns the order id', async () => {
    vendor.replies.push({ code: '200', orderId: 98765432 });
    const receipt = await adapter().sendVerificationCode({ phoneE164: '+905321234567', code: '482913' });
    expect(receipt).toEqual({ providerRef: '98765432' });
    const last = vendor.received.at(-1)!;
    expect(last.url).toBe('/v1/send-sms/json');
    expect(last.contentType).toBe('application/json');
    expect(JSON.parse(last.body)).toEqual({
      request: {
        authentication: { key: 'key-123', hash: 'hash-456' },
        order: { sender: 'VELVET', sendDateTime: [], iys: '0', message: { text: 'Your code is 482913.', receipents: { number: ['5321234567'] } } },
      },
    });
  });

  it('accepts a success without an order id (the code was sent; it must not become an outage)', async () => {
    vendor.replies.push({ code: '200', orderId: null });
    expect(await adapter().sendVerificationCode({ phoneE164: '+905321234567', code: '111111' })).toEqual({});
  });

  it('classifies every documented status code; unknown codes are outages', async () => {
    for (const [code, failure] of Object.entries(ILETIMERKEZI_FAILURES)) {
      vendor.replies.push({ code });
      expect([code, await failureOf(adapter().sendVerificationCode({ phoneE164: '+905321234567', code: '123456' }))]).toEqual([code, failure]);
    }
    vendor.replies.push({ code: '999' });
    expect(await failureOf(adapter().sendVerificationCode({ phoneE164: '+905321234567', code: '123456' }))).toBe('PROVIDER_UNAVAILABLE');
    expect(ILETIMERKEZI_FAILURES['452']).toBe('INVALID_PHONE');
    expect(ILETIMERKEZI_FAILURES['401']).toBe('PROVIDER_UNAVAILABLE');
  });

  it('a 200 body with a failure code, non-JSON, a timeout or no network are never success', async () => {
    vendor.replies.push({ http: 200, code: '402' });
    expect(await failureOf(adapter().sendVerificationCode({ phoneE164: '+905321234567', code: '123456' }))).toBe('PROVIDER_UNAVAILABLE');
    vendor.replies.push({ http: 502, raw: '<html>bad gateway</html>' });
    expect(await failureOf(adapter().sendVerificationCode({ phoneE164: '+905321234567', code: '123456' }))).toBe('PROVIDER_UNAVAILABLE');
    vendor.replies.push({ code: '200', delayMs: 300 });
    expect(await failureOf(adapter({ timeoutMs: 50 }).sendVerificationCode({ phoneE164: '+905321234567', code: '123456' }))).toBe('PROVIDER_UNAVAILABLE');
    expect(await failureOf(adapter({ baseUrl: 'http://127.0.0.1:1' }).sendVerificationCode({ phoneE164: '+905321234567', code: '123456' }))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('refuses a non-Türkiye number without calling the provider', async () => {
    const before = vendor.received.length;
    expect(await failureOf(adapter().sendVerificationCode({ phoneE164: '+447700900123', code: '123456' }))).toBe('INVALID_PHONE');
    expect(vendor.received.length).toBe(before);
  });
});

describe('İleti Merkezi configuration', () => {
  const base = {
    APP_ENV: 'staging',
    DATABASE_URL: 'postgres://u@h/d',
    DATABASE_TLS: 'require',
    OTP_SECRET: 'p'.repeat(48),
    MEDIA_SIGNING_SECRET: 'm'.repeat(48),
    INTERNAL_KEYS_JSON: JSON.stringify({ ops: { secret: 'o'.repeat(44), scopes: ['retention:run'] } }),
    PUBLIC_BASE_URL: 'https://velvet-api-staging.onrender.com',
    S3_BUCKET: 'a',
    S3_VERIFICATION_BUCKET: 'b',
    SMS_PROVIDER: 'iletimerkezi',
  };
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig(env);
      return [];
    } catch (e) {
      return (e as { problems: string[] }).problems;
    }
  };
  it('needs key, hash and an approved sender; https; a plain one-SMS template', () => {
    expect(problems(base)).toContain('ILETIMERKEZI_API_KEY, ILETIMERKEZI_API_HASH and ILETIMERKEZI_SENDER are required with SMS_PROVIDER=iletimerkezi');
    const ok = { ...base, ILETIMERKEZI_API_KEY: 'k', ILETIMERKEZI_API_HASH: 'h', ILETIMERKEZI_SENDER: 'VELVET' };
    expect(problems(ok)).toEqual([]);
    expect(problems({ ...ok, ILETIMERKEZI_SENDER: 'A-SENDER-NAME-TOO-LONG' })).toContain('ILETIMERKEZI_SENDER must be the approved sender name (at most 11 characters)');
    expect(problems({ ...ok, ILETIMERKEZI_BASE_URL: 'http://api.iletimerkezi.com' })).toContain('ILETIMERKEZI_BASE_URL must use https outside development');
    expect(problems({ ...ok, SMS_OTP_TEMPLATE: 'Doğrulama kodunuz {code}' })).toContain('SMS_OTP_TEMPLATE must be printable ASCII and at most 155 characters with the code (one plain SMS)');
  });
});

describe('through the API', () => {
  it('a provider failure reaches the applicant only as the safe "couldn’t send a code" answer', async () => {
    const t = await testServer(undefined, {}, {
      sms: ({ pool, config }) =>
        smsFor(
          { ...config, sms: { ...config.sms, provider: 'iletimerkezi', iletimerkezi: { baseUrl, apiKey: 'k', apiHash: 'h', sender: 'VELVET' } } },
          pool,
        ),
    });
    try {
      vendor.replies.push({ code: '402' });
      const r = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+905321234599' } });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('CODE_NOT_SENT');
      expect(JSON.stringify(r.body)).not.toMatch(/iletimerkezi|402|balance|bakiye/i);
      vendor.replies.push({ code: '200', orderId: '55555555' });
      const ok = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+905321234598' } });
      expect(ok.status).toBe(200);
      const sent = t.logLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'otp.sent');
      expect(sent).toMatchObject({ provider: 'route(+90→iletimerkezi)', providerRef: '55555555' }); // the order id, intact, for delivery tracing
    } finally {
      await t.close();
    }
  });
});
