# SMS provider

How sign-in codes leave the server, which provider carries them, and what
happens when sending fails.
- Decisions: DEC-061, DEC-073.
- Provider comparison: docs/INFRASTRUCTURE_DECISION.md §4.
- No secrets appear here, only variable names.

---

## The boundary

```ts
// server/src/auth/sms.ts
interface SmsProvider {
  readonly name: string;
  sendVerificationCode(message: { phoneE164: string; code: string }): Promise<{ providerRef?: string } | void>;
}
```

- The auth service knows only this interface; vendors are adapters.
- `routeSms({ '+90': netgsm })` chooses by prefix. A number with no route is
  refused (`NOT_CONFIGURED`).
- Development senders (console, outbox file, capture) are refused in staging
  and production. `SMS_PROVIDER=none` fails closed.
- The code is a random six-digit number, stored only as an HMAC and valid
  10 minutes. There is no fixed code outside the in-app mock.
- `providerRef` is the vendor's message reference (the Netgsm job id). It
  is logged with `otp.sent` so operators can trace delivery. It carries no
  personal data, and the logger keeps a 16+ digit reference intact because
  it cannot be a phone number.

## STAGING NOW: İleti Merkezi (DEC-085)

Netgsm needs a company registration, which the project does not have yet.
Staging sends through İleti Merkezi (individual account, individual sender
name). Verified 2026-10-07 against the official API docs
(github.com/iletimerkezi/apidocs-website) and the official Node SDK.

```
POST https://api.iletimerkezi.com/v1/send-sms/json
{ "request": { "authentication": { "key": "<API key>", "hash": "<API hash>" },
               "order": { "sender": "<approved, ≤ 11>", "sendDateTime": [], "iys": "0",
                          "message": { "text": "<ASCII>", "receipents": { "number": ["5XXXXXXXXX"] } } } } }
→ 200 { "response": { "status": { "code": "200", "message": "İşlem başarılı" }, "order": { "id": "…" } } }
```

- Key and hash come from the panel; the hash is derived by the panel from the
  API key and secret and is a credential. API access must be switched on
  (Ayarlar → Güvenlik → Erişim İzinleri).
- `iys: 0`: a code is not a commercial message.
- Acceptance: HTTP 200 and status "200"; the order id is logged as
  `providerRef`.
- Status codes: 452 (recipients) → `INVALID_PHONE`; 401 (credentials/IP),
  402 (balance) → `PROVIDER_UNAVAILABLE`; 400, 404, 422, 450 (sender not
  approved), 451, 453, 454, 457, 468–470 → `DELIVERY_REJECTED`; anything else,
  non-JSON, timeout, network → `PROVIDER_UNAVAILABLE`. The applicant only ever
  sees `CODE_NOT_SENT` or "check your number".
- Variables: `SMS_PROVIDER=iletimerkezi`, `ILETIMERKEZI_API_KEY`,
  `ILETIMERKEZI_API_HASH`, `ILETIMERKEZI_SENDER`, optional
  `ILETIMERKEZI_BASE_URL`.
- Tests: server/test/sms.iletimerkezi.test.ts.

## Netgsm OTP SMS (REST v2) — selected for when a company exists

**Verified 2026-10-07 against Netgsm's official API reference**
(https://www.netgsm.com.tr/dokuman/#otp-sms).

The request (adapter `netgsmSms`):
```
POST https://api.netgsm.com.tr/sms/rest/v2/otp
Authorization: Basic base64(<usercode>:<password of an "API Kullanıcısı" sub-user>)
Content-Type: application/json
{ "msgheader": "<approved header>", "msg": "<ASCII, one segment>", "no": "5XXXXXXXXX" }
→ 200 { "jobid": "…", "code": "00", "description": "success" }   or   { "code": "XX", "description": "…" }
```

- **Only `code "00"` with a job id is success.** Anything else is
  classified below. The timeout is 10 s.
- **Numbers.** The adapter refuses non-+90 numbers without calling Netgsm.
  Netgsm OTP serves Turkish mobile numbers only: no international numbers
  and no KKTC.
- **Message rules** (Netgsm): one segment, **no Turkish characters**, at
  most 155 characters with an alphanumeric header. The configuration refuses
  an `SMS_OTP_TEMPLATE` that breaks this. The default is `Your verification
  code is {code}. Do not share it.`
- **The older XML endpoint** (`/sms/send/otp`) is listed by Netgsm under
  "old versions" and is no longer used.
- **Credentials.** Since 2024-02-15 the password must belong to an **API
  sub-user**. Use one sub-user per environment: staging never shares
  production's.
- **IP allow list** (optional, in Netgsm's panel). A request from another
  address answers error 30. Render's outbound ranges are shared by every
  Render customer in the region, so an allow list on them is weak; a
  dedicated outbound IP costs extra.
- **Delivery reports.** `netgsmDeliveryReport` calls
  `POST /sms/rest/v2/report { jobids: [...] }`. Status 1 is delivered, 0 is
  waiting, anything else is not delivered. There are at most 50 ids per
  request; each id can be queried once per minute. It is used by operator
  tooling, never on the request path. Netgsm offers **no SMS delivery
  webhook**.
- **Regulation.** OTP sends skip İYS, blacklist and duplicate filtering on
  Netgsm's side. Our own limits are the abuse control. The message must stay
  purely informational: no promotion, no URL.

### Failure classification (official OTP error table)

| Netgsm code | Meaning | Internal class | Client receives |
|---|---|---|---|
| 20 | message text / length | `DELIVERY_REJECTED` | `CODE_NOT_SENT` (503) "We couldn’t send a code right now. Try again." |
| 30 | credentials, API permission or IP restriction | `PROVIDER_UNAVAILABLE` | `CODE_NOT_SENT` |
| 40, 41 | sender header | `DELIVERY_REJECTED` | `CODE_NOT_SENT` |
| 50, 51, 52 | the number | `INVALID_PHONE` | `INVALID_PHONE` (422), the app's own "check your number" copy |
| 60 | no OTP package on the account | `PROVIDER_UNAVAILABLE` | `CODE_NOT_SENT` |
| 70 | input parameters | `DELIVERY_REJECTED` | `CODE_NOT_SENT` |
| 100 | Netgsm system error | `PROVIDER_UNAVAILABLE` | `CODE_NOT_SENT` |
| anything else, non-JSON, HTTP error without a code, timeout, network | — | `PROVIDER_UNAVAILABLE` | `CODE_NOT_SENT` |

- **The undelivered challenge is consumed at once**, so it can never be used.
- **Logs** carry the class and a safe detail (`netgsm 30`, `timeout`). They
  never carry the code, the number or the message.
- **Our own limits apply:**
  - 5 codes per number per hour;
  - a 30-second resend cooldown;
  - 30 code requests per address per hour;
  - 20 verify attempts per number per hour.

## Staging

- **Test numbers.** `SMS_TEST_NUMBERS=+90555000*` sends those numbers' codes
  to the internal outbox. They never reach a phone. The outbox is readable
  once, with `test:otp` (staging only). Accounts created this way are QA
  accounts (DEC-076).
  - The prefix lies in an allocated Turkish mobile range, and Türkiye
    publishes no fictional range.
  - In staging that is harmless: such a number can never receive a code from
    us.
  - The tools refuse to run against anything that does not pass the signed,
    staging-only preflight, so they cannot send real SMS to these numbers
    through production.
- **Real delivery** is checked with project-owned SIMs, on the operator's
  machine, using `node dist/staging-otp-check.mjs [--with-limits]
  [--with-expiry]` (docs/STAGING.md §8.2). Codes exist only on the phones;
  the log review flags any six-digit number on an authentication line.
- **Project SIMs as QA accounts.** `SMS_QA_REAL_NUMBERS` (staging only, exact
  numbers, never overlapping the test numbers) lists the SIMs: real SMS, but
  QA accounts the review fixture may move — the real journey on a phone
  (DEC-083).
- **Provider outage, for real.** `staging-checks → sms-outage-drill` points
  the adapter at an unreachable host for one deploy, requests a code for the
  project SIM (nothing can be sent), expects `CODE_NOT_SENT` with no vendor
  detail, then restores and redeploys.
- **Status: BLOCKED.** There is no Netgsm account, header or package yet.
  Until then staging runs with `SMS_PROVIDER=none`, so only test numbers can
  sign in.

## Alternatives (from docs/INFRASTRUCTURE_DECISION.md)

- **İleti Merkezi**
  - Individual sender headers are possible; header checks take 1 business
    day.
  - Delivery-report webhooks; undelivered messages are not charged.
  - The choice if the project has no business registration yet. It needs one
    adapter.
- **Twilio** (Messaging with a registered sender, or Verify)
  - Türkiye requires a pre-registered alphanumeric sender. Unregistered
    senders are blocked from 2026-11-18.
  - There is no Verify sandbox.
  - The likely route for non-+90 numbers later.

## Config

| Variable | Meaning |
|---|---|
| `SMS_PROVIDER=netgsm` | select the adapter (`none` = closed) |
| `NETGSM_USERCODE` | the subscriber number (e.g. 850xxxxxxx) |
| `NETGSM_PASSWORD` | the password of the environment's **API sub-user** |
| `NETGSM_HEADER` | the approved sender header (3–11 characters) |
| `NETGSM_BASE_URL` | optional; default `https://api.netgsm.com.tr`; https outside development |
| `SMS_OTP_TEMPLATE` | optional; `{code}`; ASCII, ≤ 155 characters with the code (enforced) |
| `SMS_TEST_NUMBERS` | staging only (refused in production) |
| `SMS_QA_REAL_NUMBERS` | staging only: project SIMs, exact numbers (refused in production) |

Tests:
- server/test/sms.test.ts: the REST v2 adapter against a fake Netgsm
  (JSON, Basic auth, every error code, non-JSON, timeout, network); delivery
  reports; template rules; routing; test numbers; job id in the log.
- server/test/auth.test.ts.
