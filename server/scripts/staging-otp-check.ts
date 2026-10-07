/**
 * Real SMS check on staging (docs/STAGING.md §8.2) — operator-assisted, with
 * PROJECT-OWNED SIMs (never an applicant's number, never a designated test
 * number: those never reach a phone). The operator types each code from the
 * phone; this tool never reads a code from anywhere else, never prints one and
 * never writes one to a file. It needs no key: nothing here uses a test hook.
 *
 *   STAGING_ENVIRONMENT=staging STAGING_API_URL=https://…staging… \
 *   STAGING_REAL_PHONE=+905XXXXXXXXX [STAGING_REAL_PHONE_2=+905YYYYYYYYY] \
 *   node dist/staging-otp-check.mjs [--with-expiry] [--with-limits]
 *
 * Verifies, against the real provider through the deployed API:
 *   request → delivery (operator confirms; time recorded) → wrong code fails →
 *   correct code signs in → the same code again fails → a resend inside the
 *   cooldown is refused → after the cooldown a new code arrives, the earlier
 *   challenge is dead and the new code signs in → too many wrong attempts lock
 *   the challenge → (SIM 2, a number with no account) the request and a wrong
 *   code read exactly the same for an existing and an unknown number →
 *   (--with-limits) the hourly per-number cap refuses further sends →
 *   (--with-expiry, ~11 min) an expired code fails.
 * Every SIM account created here asks for deletion at the end. Afterwards run
 * the `log-review` staging check for the window: it flags any six-digit
 * number on an authentication line, so the codes never need to be recorded.
 *
 * About 6 real SMS (10 with --with-limits): OTP sends are paid.
 */
import { createInterface } from 'node:readline/promises';
import { maskPhone, recorder } from './lib/staging';

const env = process.env;

async function main() {
  if (env.STAGING_ENVIRONMENT !== 'staging') throw new Error('Refusing to run: set STAGING_ENVIRONMENT=staging.');
  const api = (env.STAGING_API_URL ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]*staging[^/]*$/i.test(api)) throw new Error('STAGING_API_URL must be the https staging API (its host must say "staging").');
  const phone = env.STAGING_REAL_PHONE ?? '';
  const phone2 = env.STAGING_REAL_PHONE_2 ?? '';
  if (!/^\+905\d{9}$/.test(phone)) throw new Error('STAGING_REAL_PHONE must be a project-owned Turkish mobile number (+905…).');
  if (phone2 && (!/^\+905\d{9}$/.test(phone2) || phone2 === phone)) throw new Error('STAGING_REAL_PHONE_2 must be a second, different project-owned Turkish mobile number.');
  if (!process.stdin.isTTY) throw new Error('Run this interactively: the operator types the code received on the phone.');
  const withExpiry = process.argv.includes('--with-expiry');
  const withLimits = process.argv.includes('--with-limits');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const r = recorder('real OTP check');
  const startedAt = new Date().toISOString();
  const call = async (path: string, body: unknown, token?: string) => {
    const started = Date.now();
    const res = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, ms: Date.now() - started }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  /** Reads a code without echoing it back; the value lives only in this process. */
  const ask = async (q: string) => (await rl.question(q)).trim();
  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const cooldown = async () => {
    console.log('Waiting 31 s for the resend cooldown…');
    await wait(31_000);
  };
  const otherCode = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, '0');
  const tokens: string[] = [];
  const vendorDetail = (b: unknown) => /netgsm|iletimerkezi|jobid|order|provider|description/i.test(JSON.stringify(b ?? {}));
  try {
    console.log(`Real SMS to ${maskPhone(phone)}${phone2 ? ` and ${maskPhone(phone2)}` : ''} through ${api} (started ${startedAt})`);

    // 1. Request, delivery, wrong / correct / reused code.
    const first = await call('/v1/auth/otp', { phoneE164: phone });
    const sentAt = Date.now();
    r.check('request: the API accepts the request', first.status === 200, JSON.stringify(first.body?.error ?? {}));
    if (first.status !== 200) return;
    const code = await ask('Type the 6-digit code from the SMS (or press Enter if none arrived): ');
    const seconds = Math.round((Date.now() - sentAt) / 1000);
    r.check(`delivery: the SMS arrived (operator confirmed; ≤ ${seconds} s including typing)`, /^\d{6}$/.test(code));
    if (!/^\d{6}$/.test(code)) return;
    const wrong = await call('/v1/auth/otp/verify', { challengeId: first.body.challengeId, code: otherCode(code) });
    r.check('verify: a wrong code fails (typed, no vendor detail)', wrong.body?.error?.code === 'INVALID_CODE' && !vendorDetail(wrong.body));
    const ok = await call('/v1/auth/otp/verify', { challengeId: first.body.challengeId, code });
    if (ok.body?.session?.token) tokens.push(ok.body.session.token);
    r.check('verify: the correct code signs in', ok.status === 200 && Boolean(ok.body?.session?.token));
    const reused = await call('/v1/auth/otp/verify', { challengeId: first.body.challengeId, code });
    r.check('verify: the same code cannot be used twice', reused.status !== 200 && reused.body?.error?.code === 'CODE_EXPIRED');

    // 2. Resend: inside the cooldown refused; after it, a new code; the earlier challenge is dead.
    const tooSoon = await call('/v1/auth/otp', { phoneE164: phone });
    r.check('resend: inside the cooldown it is refused', tooSoon.body?.error?.code === 'RATE_LIMITED');
    await cooldown();
    const second = await call('/v1/auth/otp', { phoneE164: phone });
    r.check('resend: after the cooldown a new code is sent', second.status === 200);
    const code2 = await ask('Type the NEW code from the second SMS: ');
    const stale = await call('/v1/auth/otp/verify', { challengeId: first.body.challengeId, code });
    r.check('resend: the earlier challenge is no longer usable', stale.status !== 200);
    const ok2 = await call('/v1/auth/otp/verify', { challengeId: second.body.challengeId, code: code2 });
    if (ok2.body?.session?.token) tokens.push(ok2.body.session.token);
    r.check('resend: the new code signs in', ok2.status === 200);

    // 3. Too many attempts: five wrong codes lock the challenge (no typing needed).
    await cooldown();
    const third = await call('/v1/auth/otp', { phoneE164: phone });
    let last: Awaited<ReturnType<typeof call>> | null = null;
    for (let i = 0; i < 6; i++) last = await call('/v1/auth/otp/verify', { challengeId: third.body?.challengeId, code: String(100000 + i) });
    r.check('attempts: after five wrong codes the challenge refuses even a sixth try', third.status === 200 && last?.body?.error?.code === 'TOO_MANY_ATTEMPTS', JSON.stringify(last?.body?.error ?? {}));
    console.log('(A third SMS arrived for that check; its code is not needed — ignore it.)');

    // 4. Existing vs unknown number: identical public answers.
    if (phone2) {
      await cooldown();
      const [existing, unknown] = await Promise.all([call('/v1/auth/otp', { phoneE164: phone }), call('/v1/auth/otp', { phoneE164: phone2 })]);
      const shape = (x: { status: number; body: unknown }) => `${x.status}:${Object.keys((x.body as object) ?? {}).sort().join()}`;
      r.check('enumeration: an existing and an unknown number get the same status and fields', shape(existing) === shape(unknown), `${shape(existing)} | ${shape(unknown)}`);
      const [we, wu] = await Promise.all([
        call('/v1/auth/otp/verify', { challengeId: existing.body?.challengeId, code: '000000' }),
        call('/v1/auth/otp/verify', { challengeId: unknown.body?.challengeId, code: '000000' }),
      ]);
      const answer = (w: { status: number; body: any }) => JSON.stringify({ s: w.status, c: w.body?.error?.code, a: w.body?.error?.attemptsRemaining, m: w.body?.error?.message }); // eslint-disable-line @typescript-eslint/no-explicit-any
      r.check('enumeration: a wrong code answers the same for both', answer(we) === answer(wu));
      console.log(`(Timing, for the record: existing ${existing.ms} ms, unknown ${unknown.ms} ms.) Both phones received a code; neither is needed.`);
    } else {
      r.blocked('enumeration with a real unknown number', 'set STAGING_REAL_PHONE_2 (a second project-owned SIM with no account)');
    }

    // 5. The hourly per-number cap (5 codes per number per hour).
    if (withLimits) {
      let refused: Awaited<ReturnType<typeof call>> | null = null;
      for (let i = 0; i < 4 && !refused; i++) {
        await cooldown();
        const x = await call('/v1/auth/otp', { phoneE164: phone });
        if (x.status !== 200) refused = x;
      }
      r.check(
        'limits: further sends to the number are refused by the hourly cap (typed RATE_LIMITED, no vendor detail)',
        refused?.body?.error?.code === 'RATE_LIMITED' && !vendorDetail(refused.body),
        JSON.stringify(refused?.body?.error ?? 'never refused'),
      );
    } else {
      r.blocked('the hourly per-number cap', 'run with --with-limits (up to 4 more SMS)');
    }

    // 6. Expiry.
    if (withExpiry) {
      await cooldown();
      console.log('Expiry check: requesting one more code, to be submitted after it expires (10 minutes)…');
      const fourth = await call('/v1/auth/otp', { phoneE164: phone2 || phone });
      if (fourth.status !== 200) {
        r.blocked('expiry: an expired code fails', `could not request a code (${fourth.body?.error?.code ?? fourth.status}) — the hourly cap; run --with-expiry on its own later`);
      } else {
        const code3 = await ask('Type the code from this SMS (it will be submitted after it expires): ');
        console.log('Waiting 10 min 15 s…');
        await wait(615_000);
        const expired = await call('/v1/auth/otp/verify', { challengeId: fourth.body.challengeId, code: code3 });
        r.check('expiry: an expired code fails', expired.body?.error?.code === 'CODE_EXPIRED');
      }
    } else {
      r.blocked('expiry: an expired code fails', 'run with --with-expiry (takes ~11 minutes)');
    }
  } finally {
    for (const token of tokens) await call('/v1/me/deletion', { confirm: true }, token).catch(() => undefined);
    rl.close();
    console.log(`\nNext: run the "log-review" staging check with since=${startedAt} (no codes were written anywhere).`);
  }
  process.exitCode = r.summary() ? 0 : 1;
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
