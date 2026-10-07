/**
 * SMS provider boundary (DEC-061, docs/SMS_PROVIDER.md).
 *
 * The auth service depends only on `SmsProvider`. Vendors are adapters;
 * routing decides which adapter serves which number. Failures are classified
 * internally (`SmsFailure`) for logs and alerts; the client only ever hears
 * "We couldn't send a code right now" (CODE_NOT_SENT) or, for numbers the
 * provider says are invalid, "Check the number" (INVALID_PHONE).
 *
 * There is no fixed or development code anywhere: development senders only
 * change where a RANDOM code is delivered (console, file, memory, or — for
 * designated test numbers in staging — an internal outbox).
 */
import { appendFileSync } from 'node:fs';
import type { Db } from '../db/pool';

export type SmsFailure = 'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED' | 'DELIVERY_REJECTED' | 'INVALID_PHONE';

export class SmsDeliveryError extends Error {
  constructor(
    readonly failure: SmsFailure,
    /** Safe, vendor-neutral detail for logs (e.g. a vendor status code). Never the message text or number. */
    readonly detail: string | null = null,
  ) {
    super(`SMS delivery failed: ${failure}`);
    this.name = 'SmsDeliveryError';
  }
}

export type VerificationMessage = { phoneE164: string; code: string };

/** What a provider may report back: its own message reference (no personal data), for delivery tracing. */
export type SmsReceipt = { providerRef?: string };

export interface SmsProvider {
  readonly name: string;
  sendVerificationCode(message: VerificationMessage): Promise<SmsReceipt | void>;
}

const render = (template: string, code: string) => template.replace('{code}', code);

// --- Development / test senders --------------------------------------------------------------

/** Development: the code appears in the server console (the number masked). */
export function consoleSms(template: string): SmsProvider {
  return {
    name: 'console',
    async sendVerificationCode({ phoneE164, code }) {
      process.stdout.write(`[sms:dev] •••${phoneE164.slice(-2)} → ${render(template, code)}\n`);
    },
  };
}

/** Automated end-to-end runs: codes are appended to a local file the runner reads. */
export function outboxFileSms(file: string): SmsProvider {
  return {
    name: 'outbox-file',
    async sendVerificationCode({ phoneE164, code }) {
      appendFileSync(file, `${JSON.stringify({ phone: phoneE164, code, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    },
  };
}

/** Tests: codes are kept in memory; failures can be injected. */
export function captureSms(): SmsProvider & {
  last(phone: string): string | null;
  sent: { phone: string; code: string }[];
  failNext(failure: SmsFailure): void;
} {
  const sent: { phone: string; code: string }[] = [];
  const failures: SmsFailure[] = [];
  return {
    name: 'capture',
    sent,
    failNext: (f) => void failures.push(f),
    async sendVerificationCode({ phoneE164, code }) {
      const f = failures.shift();
      if (f) throw new SmsDeliveryError(f, 'injected');
      sent.push({ phone: phoneE164, code });
    },
    last(phone) {
      for (let i = sent.length - 1; i >= 0; i--) if (sent[i]!.phone === phone) return sent[i]!.code;
      return null;
    },
  };
}

/** No provider configured: refuse — sign-in fails closed. */
export function unconfiguredSms(): SmsProvider {
  return {
    name: 'none',
    async sendVerificationCode() {
      throw new SmsDeliveryError('NOT_CONFIGURED');
    },
  };
}

// --- Netgsm (selected — docs/INFRASTRUCTURE_DECISION.md §4) ----------------------------------

/**
 * Netgsm OTP SMS, current REST API (verified 2026-10-07 against
 * https://www.netgsm.com.tr/dokuman/#otp-sms):
 *
 *   POST {baseUrl}/sms/rest/v2/otp
 *   Authorization: Basic base64(usercode:password)   — the password of an
 *                  "API Kullanıcısı" sub-user (one per environment)
 *   { "msgheader": "<approved header>", "msg": "<ASCII, one segment>", "no": "5XXXXXXXXX" }
 *   → { "jobid": "…", "code": "00", "description": "success" }  or  { "code": "XX", … }
 *
 * Türkiye mobile numbers only; one segment; no Turkish characters (the
 * configuration refuses a template that breaks this). The older XML endpoint
 * (/sms/send/otp) is listed by Netgsm under "old versions" and is not used.
 */
export function netgsmSms(opts: {
  baseUrl: string;
  usercode: string;
  password: string;
  header: string;
  template: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SmsProvider {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const authorization = `Basic ${Buffer.from(`${opts.usercode}:${opts.password}`).toString('base64')}`;
  return {
    name: 'netgsm',
    async sendVerificationCode({ phoneE164, code }) {
      if (!/^\+90\d{10}$/.test(phoneE164)) throw new SmsDeliveryError('INVALID_PHONE', 'not a Türkiye number');
      const body = JSON.stringify({ msgheader: opts.header, msg: render(opts.template, code), no: phoneE164.slice(3) });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
      let answer: { code?: unknown; jobid?: unknown } = {};
      try {
        const res = await doFetch(`${opts.baseUrl}/sms/rest/v2/otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authorization },
          body,
          signal: controller.signal,
        });
        const text = await res.text();
        try {
          answer = JSON.parse(text) as typeof answer;
        } catch {
          answer = {};
        }
        // Netgsm answers errors in the JSON body; a non-2xx without one is an outage.
        if (!res.ok && typeof answer.code !== 'string') throw new SmsDeliveryError('PROVIDER_UNAVAILABLE', `http ${res.status}`);
      } catch (e) {
        if (e instanceof SmsDeliveryError) throw e;
        throw new SmsDeliveryError('PROVIDER_UNAVAILABLE', controller.signal.aborted ? 'timeout' : 'network');
      } finally {
        clearTimeout(timer);
      }
      const status = typeof answer.code === 'string' ? answer.code : String(answer.code ?? '');
      // "00" is acceptance. The job id is documented as a string; a number (or its absence) must not turn a
      // delivered code into an outage — that would consume the challenge of a code the person did receive.
      if (status === '00') {
        const job = typeof answer.jobid === 'string' || typeof answer.jobid === 'number' ? String(answer.jobid) : '';
        return job ? { providerRef: job } : {};
      }
      throw new SmsDeliveryError(NETGSM_FAILURES[status] ?? 'PROVIDER_UNAVAILABLE', `netgsm ${status || 'unparsed'}`);
    },
  };
}

/** Netgsm OTP error codes (official OTP error table) → our classification. Unknown codes are outages. */
export const NETGSM_FAILURES: Record<string, SmsFailure> = {
  '20': 'DELIVERY_REJECTED', // message text / length (≤ 155 with an alphanumeric header)
  '30': 'PROVIDER_UNAVAILABLE', // credentials, API permission or IP restriction — a configuration fault
  '40': 'DELIVERY_REJECTED', // sender header
  '41': 'DELIVERY_REJECTED', // sender header
  '50': 'INVALID_PHONE', // recipient number
  '51': 'INVALID_PHONE', // recipient number
  '52': 'INVALID_PHONE', // recipient number
  '60': 'PROVIDER_UNAVAILABLE', // no OTP package on the account
  '70': 'DELIVERY_REJECTED', // input parameters
  '100': 'PROVIDER_UNAVAILABLE', // provider system error
};

/**
 * İleti Merkezi (DEC-085) — the staging SMS provider while the project has no
 * company registration (Netgsm requires one; İleti Merkezi accepts individual
 * accounts and individual sender names). Verified 2026-10-07 against the
 * official API docs (github.com/iletimerkezi/apidocs-website, docs/sms/send/
 * json.mdx and status-codes.mdx) and the official Node SDK:
 *
 *   POST https://api.iletimerkezi.com/v1/send-sms/json
 *   { "request": { "authentication": { "key": <API key>, "hash": <API hash> },
 *                  "order": { "sender": <approved sender>, "sendDateTime": [], "iys": "0",
 *                             "message": { "text": …, "receipents": { "number": ["5XXXXXXXXX"] } } } } }
 *   → { "response": { "status": { "code": "200", "message": "İşlem başarılı" }, "order": { "id": "…" } } }
 *
 * - Key and hash come from the panel (Ayarlar → API); the hash is derived by
 *   the panel from the API key and secret, and is a credential.
 * - `iys: 0`: a one-time code is not a commercial message (no İYS query).
 * - API access must be enabled in the panel (Ayarlar → Güvenlik → Erişim İzinleri).
 * - Only HTTP 200 with status code "200" and an order id is acceptance.
 */
export function iletimerkeziSms(opts: {
  baseUrl: string;
  apiKey: string;
  apiHash: string;
  sender: string;
  template: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SmsProvider {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    name: 'iletimerkezi',
    async sendVerificationCode({ phoneE164, code }) {
      if (!/^\+90\d{10}$/.test(phoneE164)) throw new SmsDeliveryError('INVALID_PHONE', 'not a Türkiye number');
      const body = JSON.stringify({
        request: {
          authentication: { key: opts.apiKey, hash: opts.apiHash },
          order: { sender: opts.sender, sendDateTime: [], iys: '0', message: { text: render(opts.template, code), receipents: { number: [phoneE164.slice(3)] } } },
        },
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
      let http = 0;
      let answer: { response?: { status?: { code?: unknown }; order?: { id?: unknown } } } = {};
      try {
        const res = await doFetch(`${opts.baseUrl}/v1/send-sms/json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal: controller.signal,
        });
        http = res.status;
        const text = await res.text();
        try {
          answer = JSON.parse(text) as typeof answer;
        } catch {
          answer = {};
        }
      } catch {
        throw new SmsDeliveryError('PROVIDER_UNAVAILABLE', controller.signal.aborted ? 'timeout' : 'network');
      } finally {
        clearTimeout(timer);
      }
      const status = String(answer.response?.status?.code ?? '');
      const order = answer.response?.order?.id;
      if (http === 200 && status === '200') {
        const ref = typeof order === 'string' || typeof order === 'number' ? String(order) : '';
        return ref ? { providerRef: ref } : {};
      }
      throw new SmsDeliveryError(ILETIMERKEZI_FAILURES[status] ?? 'PROVIDER_UNAVAILABLE', `iletimerkezi ${status || `http ${http || 'unparsed'}`}`);
    },
  };
}

/** İleti Merkezi status codes (official status-code table) → our classification. Unknown codes are outages. */
export const ILETIMERKEZI_FAILURES: Record<string, SmsFailure> = {
  '400': 'DELIVERY_REJECTED', // request could not be parsed
  '401': 'PROVIDER_UNAVAILABLE', // credentials or IP restriction — a configuration fault
  '402': 'PROVIDER_UNAVAILABLE', // insufficient balance
  '404': 'DELIVERY_REJECTED', // unknown method
  '422': 'DELIVERY_REJECTED', // request values not valid
  '450': 'DELIVERY_REJECTED', // sender name not approved for the account
  '451': 'DELIVERY_REJECTED', // duplicate order within 10 minutes
  '452': 'INVALID_PHONE', // recipients invalid
  '453': 'DELIVERY_REJECTED', // order too large
  '454': 'DELIVERY_REJECTED', // empty text
  '457': 'DELIVERY_REJECTED', // send date format
  '468': 'DELIVERY_REJECTED', // İYS flag missing
  '469': 'DELIVERY_REJECTED', // İYS list missing
  '470': 'DELIVERY_REJECTED', // İYS code missing
};

/** Delivery state of one sent message, from Netgsm's report API (ops tooling only — never the code or text). */
export type NetgsmDelivery = { jobId: string; state: 'PENDING' | 'DELIVERED' | 'FAILED'; status: number; errorCode: number | null; deliveredAt: string | null };

/**
 * Netgsm delivery reports: POST {baseUrl}/sms/rest/v2/report { jobids: [...] }
 * (Basic auth; ≤ 50 job ids per request; each job id at most once a minute).
 * Status 0 = waiting, 1 = delivered, anything else = not delivered
 * (https://www.netgsm.com.tr/dokuman/#json-post-rapor). Used by the staging
 * OTP check (scripts/staging-otp-check.ts), not by the request path.
 */
export async function netgsmDeliveryReport(
  opts: { baseUrl: string; usercode: string; password: string; fetch?: typeof fetch; timeoutMs?: number },
  jobIds: string[],
): Promise<NetgsmDelivery[]> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(`${opts.baseUrl}/sms/rest/v2/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${opts.usercode}:${opts.password}`).toString('base64')}` },
      body: JSON.stringify({ jobids: jobIds.slice(0, 50) }),
      signal: controller.signal,
    });
    const answer = (await res.json().catch(() => ({}))) as { code?: string; jobs?: { jobid?: string; status?: number; errorCode?: number; deliveredDate?: string }[] | null };
    if (answer.code !== '00' || !Array.isArray(answer.jobs)) throw new SmsDeliveryError('PROVIDER_UNAVAILABLE', `netgsm report ${answer.code ?? res.status}`);
    return answer.jobs.map((j) => ({
      jobId: String(j.jobid ?? ''),
      state: j.status === 1 ? 'DELIVERED' : j.status === 0 ? 'PENDING' : 'FAILED',
      status: Number(j.status ?? -1),
      errorCode: typeof j.errorCode === 'number' && j.errorCode !== 0 ? j.errorCode : null,
      deliveredAt: j.deliveredDate ?? null,
    }));
  } catch (e) {
    if (e instanceof SmsDeliveryError) throw e;
    throw new SmsDeliveryError('PROVIDER_UNAVAILABLE', controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

// --- Routing ------------------------------------------------------------------------------------

/**
 * Choose a provider by number. `routes` maps E.164 prefixes to providers
 * (longest prefix wins); numbers with no route are refused as NOT_CONFIGURED
 * — never sent through an unsuitable channel.
 */
export function routeSms(routes: Record<string, SmsProvider>, fallback: SmsProvider | null = null): SmsProvider {
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  return {
    name: `route(${prefixes.map((p) => `${p}→${routes[p]!.name}`).join(',')}${fallback ? `,*→${fallback.name}` : ''})`,
    async sendVerificationCode(m) {
      const prefix = prefixes.find((p) => m.phoneE164.startsWith(p));
      const provider = prefix ? routes[prefix]! : fallback;
      if (!provider) throw new SmsDeliveryError('NOT_CONFIGURED', 'no route for country');
      return provider.sendVerificationCode(m);
    },
  };
}

/**
 * Staging/test only: codes for designated TEST numbers are written to the
 * internal test outbox (read once by the smoke principal) instead of being
 * sent. Every other number goes to the real provider. Refused in production
 * by configuration.
 */
/** Is this number one of the designated test numbers (exact, or a prefix ending in *)? */
export function isTestNumber(numbers: readonly string[], phone: string): boolean {
  return numbers.some((n) => (n.endsWith('*') ? phone.startsWith(n.slice(0, -1)) : phone === n));
}

export function withTestNumbers(
  inner: SmsProvider,
  opts: { numbers: string[]; db: Db; clock: () => Date; ttlMs: number },
): SmsProvider {
  const matches = (phone: string) => isTestNumber(opts.numbers, phone);
  return {
    name: `${inner.name}+test-numbers`,
    async sendVerificationCode(m) {
      if (!matches(m.phoneE164)) return inner.sendVerificationCode(m);
      const now = opts.clock();
      await opts.db.query(
        `INSERT INTO app.sms_test_outbox (phone_e164, code, created_at, expires_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone_e164) DO UPDATE SET code = EXCLUDED.code, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
        [m.phoneE164, m.code, now.toISOString(), new Date(now.getTime() + opts.ttlMs).toISOString()],
      );
    },
  };
}
