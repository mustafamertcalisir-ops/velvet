/**
 * Structured logging: one JSON object per line, with the request id of the
 * request being served (AsyncLocalStorage). Fields pass through a redactor
 * before they are written, as a safety net: callers log safe facts (codes,
 * ids, counts), and anything that looks like a secret or personal data is
 * dropped by key (DEC-069).
 *
 * Never logged: OTP codes, session tokens, full phone numbers, dates of
 * birth, signed or verification media URLs, Dating identity and preferences,
 * reviewer notes, request bodies.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type Context = { requestId: string };
export const requestContext = new AsyncLocalStorage<Context>();
export const currentRequestId = () => requestContext.getStore()?.requestId ?? null;

/** Keys never written, at any depth. */
const DENY = /^(phone|phonee164|phone_e164|msisdn|no|code|otp|token|authorization|cookie|password|secret|apikey|api_key|dob|dateofbirth|date_of_birth|lastname|last_name|surname|instagram|instagram_handle|selfdescription|self_description|seeking|appearsas|appears_as|gender|agerange|age_min|age_max|url|uri|signedurl|body|notes|note|referral|referrals|storagekey|storage_key|sig|signature)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: maskPhones(value.message) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // A provider's message reference (e.g. a 26-digit Netgsm job id) is longer than any E.164 number
      // (≤ 15 digits), so it cannot be a phone: kept intact so operators can trace delivery.
      if (k === 'providerRef' && typeof v === 'string' && /^[0-9]{16,40}$/.test(v)) out[k] = v;
      else out[k] = DENY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return maskPhones(value);
  return value;
}

/** Any E.164-looking number in free text keeps only its last two digits. */
export function maskPhones(s: string): string {
  return s.replace(/\+?\d[\d\s]{8,16}\d/g, (m) => `•••${m.replace(/\D/g, '').slice(-2)}`);
}

export type Logger = {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export function createLogger(opts: { level: LogLevel; write?: (line: string) => void; service?: string }): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[opts.level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      service: opts.service ?? 'velvet-api',
      event,
      requestId: currentRequestId(),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    write(JSON.stringify(entry));
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

/** For tests: capture lines. */
export function memoryLogger(level: LogLevel = 'debug') {
  const lines: string[] = [];
  return { logger: createLogger({ level, write: (l) => lines.push(l) }), lines };
}
