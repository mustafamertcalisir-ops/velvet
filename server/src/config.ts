/**
 * Server configuration — environment only, validated once at startup. No
 * source edits between environments; secrets come from the deployment's
 * secret store and are never committed (server/.env.example lists names only).
 *
 *   development  laptop: console SMS, local object store, open CORS, dev seed allowed
 *   test         automated tests and E2E: capture / outbox SMS, local object store
 *   staging      production-shaped: real SMS provider (or closed), S3-compatible
 *                private storage, https, signed internal auth; designated TEST
 *                numbers may be routed to an internal outbox for the smoke flow
 *   production   staging minus every test hook
 *
 * Staging and production are fail-closed: anything development-shaped refuses
 * to start (DEC-061, DEC-068).
 */
import { databaseOptionsFrom, type DatabaseOptions } from './db/pool';
import { runtimeDatabaseUrl } from './db/runtimeLogin';
import { isTestNumber } from './auth/sms';

export type AppEnv = 'production' | 'staging' | 'development' | 'test';

export type SmsProviderName = 'console' | 'outbox-file' | 'capture' | 'netgsm' | 'iletimerkezi' | 'none';

export const INTERNAL_SCOPES = [
  'review:read',
  'review:write',
  'review:media',
  'membership:complimentary',
  'billing:write',
  'safety:write',
  'retention:run',
  'media:reconcile',
  'test:otp',
  'test:review',
] as const;
export type InternalScope = (typeof INTERNAL_SCOPES)[number];
/**
 * Scopes that exist only for staging/test tooling — refused in production.
 * membership:complimentary (invited memberships, DEC-088) is staging-only until
 * a production policy for complimentary memberships is decided.
 */
export const TEST_ONLY_SCOPES: readonly InternalScope[] = ['test:otp', 'test:review', 'membership:complimentary'];

export type StorageConfig =
  | { driver: 'local'; dir: string }
  | {
      driver: 's3';
      region: string;
      endpoint: string | null;
      bucket: string;
      /** The most private class lives in its own bucket (DEC-063). */
      verificationBucket: string;
      accessKeyId: string | null;
      secretAccessKey: string | null;
      forcePathStyle: boolean;
    };

export type Config = {
  appEnv: AppEnv;
  port: number;
  host: string;
  /** The API's own (least-privilege) role. Never the schema owner in staging/production (DEC-074). */
  databaseUrl: string;
  database: DatabaseOptions;
  /** Keys the OTP hash. */
  otpSecret: string;
  /** Keys signed URLs of the local object store and local delivery. */
  mediaSigningSecret: string;
  /** Internal callers (review tooling, billing adapter, smoke tests): key id → secret + scopes. */
  internalKeys: Record<string, { secret: string; scopes: InternalScope[] }>;
  /** Base URL clients use to reach this API. */
  publicBaseUrl: string;
  corsOrigins: string[];
  /**
   * How many reverse proxies in front of the API append to X-Forwarded-For.
   * 0 = use the socket address (no proxy); 1 = the last entry is the client
   * address as seen by our proxy. Entries a client sends itself are never
   * trusted beyond that, so per-address limits cannot be dodged by spoofing.
   */
  trustProxyHops: number;
  /**
   * Optional network restriction in front of the signatures: when set, every
   * /internal/* route also requires the caller's address (resolved with
   * trustProxyHops) to fall in one of these CIDR ranges. Never a substitute
   * for signing (DEC-070).
   */
  internalAllowedCidrs: string[];
  sms: {
    provider: SmsProviderName;
    outboxFile: string | null;
    netgsm: { baseUrl: string; usercode: string; password: string; header: string } | null;
    iletimerkezi: { baseUrl: string; apiKey: string; apiHash: string; sender: string } | null;
    /** Message text; `{code}` is replaced. ASCII keeps OTP SMS single-part. */
    template: string;
    /** Staging/test only: numbers (or prefixes ending in *) whose codes go to the internal test outbox. */
    testNumbers: string[];
    /**
     * Staging/test only: exact project-owned SIM numbers whose accounts are QA accounts (DEC-076, DEC-083)
     * although their codes go out by real SMS — the full real-OTP journey through the review fixture.
     */
    qaRealNumbers: string[];
  };
  storage: StorageConfig;
  timeZone: string;
  sessionTtlDays: number;
  sessionIdleDays: number;
  devSeed: boolean;
  /** Development/test apply migrations at start; staging/production run them as a separate release step. */
  migrateOnStart: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Retention windows (docs/DATA_RETENTION.md). Each is a POLICY decision that
   * has not been made yet: unset (null) means the retention process never
   * purges that class automatically. Nothing here is a legal determination.
   */
  retention: {
    /** Hours between a deletion request and anonymization (an undo window, if the product offers one). */
    deletionGraceHours: number;
    removedProfileMediaDays: number | null;
    retiredApplicationMediaDays: number | null;
    verificationMediaDays: number | null;
    authRecordsDays: number | null;
    safetyRecordsDays: number | null;
    auditRecordsDays: number | null;
  };
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid server configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const DEV_SMS: readonly SmsProviderName[] = ['console', 'outbox-file', 'capture'];

/** A parsed CIDR range: 16-byte address (IPv4 mapped into IPv6) + prefix length over 128 bits. */
export type Cidr = { bytes: Uint8Array; bits: number };

/** Parse an IPv4 or IPv6 address into 16 bytes (IPv4 as ::ffff:a.b.c.d). */
export function parseIp(ip: string): Uint8Array | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.replace(/^::ffff:/i, ''));
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...parts]);
  }
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(':')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

export function parseCidr(range: string): Cidr | null {
  const m = /^(.+)\/(\d{1,3})$/.exec(range);
  if (!m) return null;
  const [addr, len] = [m[1]!, Number(m[2])];
  const bytes = parseIp(addr);
  if (!bytes) return null;
  if (!addr.includes(':')) return len <= 32 ? { bytes, bits: 96 + len } : null; // plain IPv4
  return len <= 128 ? { bytes, bits: len } : null;
}

export function ipInCidrs(ip: string, ranges: readonly string[]): boolean {
  const a = parseIp(ip);
  if (!a) return false;
  return ranges.some((r) => {
    const c = parseCidr(r);
    if (!c) return false;
    for (let i = 0; i < 16; i++) {
      const take = Math.max(0, Math.min(8, c.bits - i * 8));
      if (take === 0) return true;
      const mask = (0xff << (8 - take)) & 0xff;
      if ((a[i]! & mask) !== (c.bytes[i]! & mask)) return false;
    }
    return true;
  });
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const appEnv = (env.APP_ENV ?? 'development') as AppEnv;
  if (!['production', 'staging', 'development', 'test'].includes(appEnv)) problems.push(`APP_ENV "${appEnv}" is not recognised`);
  const releaseLike = appEnv === 'production' || appEnv === 'staging';
  const production = appEnv === 'production';

  const secret = (name: string, devDefault: string) => {
    const v = env[name];
    if (v && v.length >= 32) return v;
    if (releaseLike) problems.push(`${name} must be set to at least 32 characters`);
    else if (v) problems.push(`${name} must be at least 32 characters`);
    return devDefault;
  };

  // --- Internal callers -------------------------------------------------------------
  let internalKeys: Config['internalKeys'] = {};
  if (env.INTERNAL_KEYS_JSON) {
    try {
      // Each key carries its secret inline ("secret") or names the environment variable holding it
      // ("secretEnv": INTERNAL_KEY_*), so the key list itself can live in the Blueprint and the secret can be
      // generated by the platform and never handled by a person (DEC-081).
      const parsed = JSON.parse(env.INTERNAL_KEYS_JSON) as Record<string, { secret?: unknown; secretEnv?: unknown; scopes?: unknown }>;
      for (const [id, k] of Object.entries(parsed)) {
        if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) problems.push(`INTERNAL_KEYS_JSON: invalid key id "${id}"`);
        const scopes = Array.isArray(k.scopes) ? (k.scopes as string[]) : [];
        const unknown = scopes.filter((s) => !(INTERNAL_SCOPES as readonly string[]).includes(s));
        if (unknown.length) problems.push(`INTERNAL_KEYS_JSON: "${id}" has unknown scopes ${unknown.join(', ')}`);
        let keySecret: unknown = k.secret;
        if (k.secretEnv !== undefined) {
          if (k.secret !== undefined) problems.push(`INTERNAL_KEYS_JSON: "${id}" has both secret and secretEnv`);
          if (typeof k.secretEnv !== 'string' || !/^INTERNAL_KEY_[A-Z0-9_]{1,60}$/.test(k.secretEnv)) {
            problems.push(`INTERNAL_KEYS_JSON: "${id}" secretEnv must name an INTERNAL_KEY_* variable`);
          } else {
            keySecret = env[k.secretEnv];
          }
        }
        if (typeof keySecret !== 'string' || keySecret.length < 32) problems.push(`INTERNAL_KEYS_JSON: "${id}" secret must be at least 32 characters`);
        if (production && scopes.some((s) => TEST_ONLY_SCOPES.includes(s as InternalScope))) {
          problems.push(`INTERNAL_KEYS_JSON: "${id}" has a test-only scope, refused in production`);
        }
        internalKeys[id] = { secret: String(keySecret ?? ''), scopes: scopes as InternalScope[] };
      }
    } catch {
      problems.push('INTERNAL_KEYS_JSON is not valid JSON');
    }
  } else if (!releaseLike) {
    internalKeys = {
      dev: { secret: 'development-only-internal-key-000000000000', scopes: [...INTERNAL_SCOPES] },
    };
  }

  // --- SMS ---------------------------------------------------------------------------------
  const sms = (env.SMS_PROVIDER ?? (releaseLike ? 'none' : 'console')) as SmsProviderName;
  if (!['console', 'outbox-file', 'capture', 'netgsm', 'iletimerkezi', 'none'].includes(sms)) problems.push(`SMS_PROVIDER "${sms}" is not recognised`);
  if (releaseLike && DEV_SMS.includes(sms)) problems.push(`SMS_PROVIDER "${sms}" is a development sender and cannot run in ${appEnv}`);
  const outboxFile = env.SMS_OUTBOX_FILE ?? null;
  if (sms === 'outbox-file' && !outboxFile) problems.push('SMS_OUTBOX_FILE is required with SMS_PROVIDER=outbox-file');
  let netgsm: Config['sms']['netgsm'] = null;
  if (sms === 'netgsm') {
    const usercode = env.NETGSM_USERCODE ?? '';
    const password = env.NETGSM_PASSWORD ?? '';
    const header = env.NETGSM_HEADER ?? '';
    if (!usercode || !password || !header) problems.push('NETGSM_USERCODE, NETGSM_PASSWORD and NETGSM_HEADER are required with SMS_PROVIDER=netgsm');
    const baseUrl = (env.NETGSM_BASE_URL ?? 'https://api.netgsm.com.tr').replace(/\/+$/, '');
    if (releaseLike && !baseUrl.startsWith('https://')) problems.push('NETGSM_BASE_URL must use https outside development');
    netgsm = { baseUrl, usercode, password, header };
  }
  let iletimerkezi: Config['sms']['iletimerkezi'] = null;
  if (sms === 'iletimerkezi') {
    const apiKey = env.ILETIMERKEZI_API_KEY ?? '';
    const apiHash = env.ILETIMERKEZI_API_HASH ?? '';
    const sender = env.ILETIMERKEZI_SENDER ?? '';
    if (!apiKey || !apiHash || !sender) problems.push('ILETIMERKEZI_API_KEY, ILETIMERKEZI_API_HASH and ILETIMERKEZI_SENDER are required with SMS_PROVIDER=iletimerkezi');
    if (sender && !/^[A-Za-z0-9 .-]{1,11}$/.test(sender)) problems.push('ILETIMERKEZI_SENDER must be the approved sender name (at most 11 characters)');
    const baseUrl = (env.ILETIMERKEZI_BASE_URL ?? 'https://api.iletimerkezi.com').replace(/\/+$/, '');
    if (releaseLike && !baseUrl.startsWith('https://')) problems.push('ILETIMERKEZI_BASE_URL must use https outside development');
    iletimerkezi = { baseUrl, apiKey, apiHash, sender };
  }
  const testNumbers = (env.SMS_TEST_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (production && testNumbers.length) problems.push('SMS_TEST_NUMBERS is a test hook and is refused in production');
  if (testNumbers.some((n) => !/^\+\d{6,15}\*?$/.test(n))) problems.push('SMS_TEST_NUMBERS entries must be E.164 numbers, optionally ending in * as a prefix');
  const qaRealNumbers = (env.SMS_QA_REAL_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (production && qaRealNumbers.length) problems.push('SMS_QA_REAL_NUMBERS is a staging QA hook and is refused in production');
  if (qaRealNumbers.some((n) => !/^\+\d{8,15}$/.test(n))) problems.push('SMS_QA_REAL_NUMBERS entries must be exact E.164 numbers (no prefixes)');
  if (qaRealNumbers.some((n) => isTestNumber(testNumbers, n))) problems.push('SMS_QA_REAL_NUMBERS must not overlap SMS_TEST_NUMBERS (those never reach a phone)');
  const template = env.SMS_OTP_TEMPLATE ?? 'Your verification code is {code}. Do not share it.';
  if (!template.includes('{code}')) problems.push('SMS_OTP_TEMPLATE must contain {code}');
  // One plain segment for every real provider: Netgsm OTP requires it (no Turkish characters, ≤ 155); for
  // İleti Merkezi it keeps each code a single, predictable SMS (docs/SMS_PROVIDER.md).
  if ((sms === 'netgsm' || sms === 'iletimerkezi') && (!/^[\x20-\x7e]*$/.test(template) || template.replace('{code}', '000000').length > 155)) {
    problems.push('SMS_OTP_TEMPLATE must be printable ASCII and at most 155 characters with the code (one plain SMS)');
  }

  // --- Storage -------------------------------------------------------------------------------
  const driver = env.STORAGE_DRIVER ?? (releaseLike ? 's3' : 'local');
  let storage: StorageConfig;
  if (driver === 's3') {
    const bucket = env.S3_BUCKET ?? '';
    const verificationBucket = env.S3_VERIFICATION_BUCKET ?? '';
    if (!bucket || !verificationBucket) problems.push('S3_BUCKET and S3_VERIFICATION_BUCKET are required with STORAGE_DRIVER=s3');
    if (bucket && bucket === verificationBucket && releaseLike) problems.push('S3_VERIFICATION_BUCKET must be a separate bucket from S3_BUCKET');
    storage = {
      driver: 's3',
      region: env.S3_REGION ?? 'auto',
      endpoint: env.S3_ENDPOINT ?? null,
      bucket,
      verificationBucket,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? null,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === '1',
    };
  } else if (driver === 'local') {
    if (releaseLike) problems.push(`STORAGE_DRIVER=local is a development store and cannot run in ${appEnv}`);
    storage = { driver: 'local', dir: env.MEDIA_DIR ?? './.media' };
  } else {
    problems.push(`STORAGE_DRIVER "${driver}" is not recognised`);
    storage = { driver: 'local', dir: './.media' };
  }

  const devSeed = env.DEV_SEED === '1';
  if (releaseLike && devSeed) problems.push('DEV_SEED cannot be enabled outside development');

  // DATABASE_URL, or a runtime login generated by the platform and managed by the release step (DEC-081).
  const runtime = runtimeDatabaseUrl(env);
  problems.push(...runtime.problems);
  const databaseUrl = runtime.url;
  const db = databaseOptionsFrom(env, releaseLike);
  problems.push(...db.problems);
  if (releaseLike && env.MIGRATION_DATABASE_URL && env.MIGRATION_DATABASE_URL === databaseUrl) {
    problems.push('DATABASE_URL must be the runtime role, not the same credential as MIGRATION_DATABASE_URL');
  }

  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0) problems.push('PORT must be a positive integer');

  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  if (releaseLike && !publicBaseUrl.startsWith('https://')) problems.push(`PUBLIC_BASE_URL must use https in ${appEnv}`);

  const corsOrigins = (env.CORS_ORIGINS ?? (releaseLike ? '' : '*'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (releaseLike && corsOrigins.includes('*')) problems.push('CORS_ORIGINS cannot be "*" outside development');

  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? (releaseLike ? 0 : 1));
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) problems.push('TRUST_PROXY_HOPS must be 0–5');

  const internalAllowedCidrs = (env.INTERNAL_ALLOWED_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of internalAllowedCidrs) if (!parseCidr(c)) problems.push(`INTERNAL_ALLOWED_CIDRS: "${c}" is not an IPv4/IPv6 CIDR range`);

  const logLevel = (env.LOG_LEVEL ?? (releaseLike ? 'info' : 'warn')) as Config['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) problems.push(`LOG_LEVEL "${logLevel}" is not recognised`);

  const days = (name: string): number | null => {
    const v = env[name];
    if (v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) problems.push(`${name} must be a whole number of days (≥ 1) or unset`);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  const graceHours = Number(env.ACCOUNT_DELETION_GRACE_HOURS ?? 0);
  if (!Number.isInteger(graceHours) || graceHours < 0) problems.push('ACCOUNT_DELETION_GRACE_HOURS must be a whole number of hours (≥ 0)');

  const config: Config = {
    appEnv,
    port,
    host: env.HOST ?? (releaseLike ? '0.0.0.0' : '127.0.0.1'),
    databaseUrl,
    database: db.options,
    otpSecret: secret('OTP_SECRET', 'development-only-otp-secret-0000000000'),
    mediaSigningSecret: secret('MEDIA_SIGNING_SECRET', 'development-only-media-secret-00000000'),
    internalKeys,
    publicBaseUrl,
    corsOrigins,
    trustProxyHops: Number.isInteger(trustProxyHops) ? trustProxyHops : 0,
    internalAllowedCidrs,
    sms: { provider: sms, outboxFile, netgsm, iletimerkezi, template, testNumbers, qaRealNumbers },
    storage,
    timeZone: env.APP_TIME_ZONE ?? 'Europe/Istanbul',
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 60),
    sessionIdleDays: Number(env.SESSION_IDLE_DAYS ?? 30),
    devSeed,
    migrateOnStart: env.MIGRATE_ON_START ? env.MIGRATE_ON_START === '1' : !releaseLike,
    logLevel,
    retention: {
      deletionGraceHours: Number.isInteger(graceHours) && graceHours >= 0 ? graceHours : 0,
      removedProfileMediaDays: days('RETENTION_REMOVED_PROFILE_MEDIA_DAYS'),
      retiredApplicationMediaDays: days('RETENTION_RETIRED_APPLICATION_MEDIA_DAYS'),
      verificationMediaDays: days('RETENTION_VERIFICATION_MEDIA_DAYS'),
      authRecordsDays: days('RETENTION_AUTH_RECORDS_DAYS'),
      safetyRecordsDays: days('RETENTION_SAFETY_RECORDS_DAYS'),
      auditRecordsDays: days('RETENTION_AUDIT_DAYS'),
    },
  };
  if (!(config.sessionIdleDays > 0 && config.sessionTtlDays >= config.sessionIdleDays)) problems.push('SESSION_IDLE_DAYS must be > 0 and ≤ SESSION_TTL_DAYS');
  if (problems.length) throw new ConfigError(problems);
  return config;
}
