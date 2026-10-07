/** Release safety: production configuration is fail-closed; no development shortcuts survive. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { createAuthService } from '../src/auth/service';
import { unconfiguredSms } from '../src/auth/sms';
import { memoryLogger } from '../src/lib/log';

const strong = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://api@db/velvet',
  OTP_SECRET: 'p'.repeat(48),
  MEDIA_SIGNING_SECRET: 'm'.repeat(48),
  INTERNAL_KEYS_JSON: JSON.stringify({ billing: { secret: 'b'.repeat(48), scopes: ['billing:write'] }, review: { secret: 'r'.repeat(48), scopes: ['review:write', 'review:media'] } }),
  PUBLIC_BASE_URL: 'https://api.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  S3_BUCKET: 'velvet-media',
  S3_VERIFICATION_BUCKET: 'velvet-verification',
};

const problems = (env: Record<string, string | undefined>) => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    return (e as ConfigError).problems;
  }
};

describe('production configuration', () => {
  it('accepts a complete production configuration; sign-in stays closed until an SMS provider exists', () => {
    const c = loadConfig(strong);
    expect(c.sms.provider).toBe('none');
    expect(c.devSeed).toBe(false);
    expect(c.storage.driver).toBe('s3');
    expect(c.migrateOnStart).toBe(false);
    expect(c.trustProxyHops).toBe(0);
    // Retention windows are policy decisions not yet made: nothing is purged by default.
    expect(c.retention).toEqual({
      deletionGraceHours: 0,
      removedProfileMediaDays: null,
      retiredApplicationMediaDays: null,
      verificationMediaDays: null,
      authRecordsDays: null,
      safetyRecordsDays: null,
      auditRecordsDays: null,
    });
  });

  it('refuses test hooks in production; allows them only in staging/test', () => {
    const testKey = JSON.stringify({ smoke: { secret: 's'.repeat(48), scopes: ['test:otp'] } });
    expect(problems({ ...strong, INTERNAL_KEYS_JSON: testKey })).toEqual([expect.stringMatching(/test-only scope/)]);
    expect(problems({ ...strong, SMS_TEST_NUMBERS: '+905550000001' })).toEqual([expect.stringMatching(/SMS_TEST_NUMBERS/)]);
    expect(problems({ ...strong, APP_ENV: 'staging', INTERNAL_KEYS_JSON: testKey, SMS_TEST_NUMBERS: '+90555000*' })).toEqual([]);
    expect(problems({ ...strong, INTERNAL_KEYS_JSON: JSON.stringify({ xx: { secret: 'short', scopes: ['nope'] } }) })).toEqual([
      expect.stringMatching(/unknown scopes/),
      expect.stringMatching(/at least 32/),
    ]);
    expect(problems({ ...strong, INTERNAL_KEYS_JSON: '{' })).toEqual([expect.stringMatching(/not valid JSON/)]);
  });

  it('refuses development storage, a shared verification bucket, incomplete SMS credentials and bad retention values', () => {
    expect(problems({ ...strong, APP_ENV: 'staging', STORAGE_DRIVER: 'local' })).toEqual([expect.stringMatching(/development store/)]);
    expect(problems({ ...strong, S3_VERIFICATION_BUCKET: 'velvet-media' })).toEqual([expect.stringMatching(/separate bucket/)]);
    expect(problems({ ...strong, S3_BUCKET: undefined })).toEqual([expect.stringMatching(/S3_BUCKET/)]);
    expect(problems({ ...strong, SMS_PROVIDER: 'netgsm' })).toEqual([expect.stringMatching(/NETGSM_USERCODE/)]);
    expect(problems({ ...strong, SMS_PROVIDER: 'netgsm', NETGSM_USERCODE: 'u', NETGSM_PASSWORD: 'p', NETGSM_HEADER: 'H', NETGSM_BASE_URL: 'http://x' })).toEqual([
      expect.stringMatching(/https/),
    ]);
    expect(problems({ ...strong, RETENTION_SAFETY_RECORDS_DAYS: '0' })).toEqual([expect.stringMatching(/RETENTION_SAFETY_RECORDS_DAYS/)]);
    expect(problems({ ...strong, ACCOUNT_DELETION_GRACE_HOURS: '-1' })).toEqual([expect.stringMatching(/GRACE/)]);
    expect(loadConfig({ ...strong, RETENTION_VERIFICATION_MEDIA_DAYS: '30' }).retention.verificationMediaDays).toBe(30);
  });

  it('refuses development senders, development seeding, weak or missing secrets, open CORS and plain http', () => {
    expect(problems({ ...strong, SMS_PROVIDER: 'console' })).toEqual([expect.stringMatching(/development sender/)]);
    expect(problems({ ...strong, SMS_PROVIDER: 'outbox-file', SMS_OUTBOX_FILE: '/tmp/x' })).toEqual([expect.stringMatching(/development sender/)]);
    expect(problems({ ...strong, SMS_PROVIDER: 'capture' })).toEqual([expect.stringMatching(/development sender/)]);
    expect(problems({ ...strong, DEV_SEED: '1' })).toEqual([expect.stringMatching(/DEV_SEED/)]);
    expect(problems({ ...strong, OTP_SECRET: 'short' })).toEqual([expect.stringMatching(/OTP_SECRET/)]);
    expect(problems({ ...strong, MEDIA_SIGNING_SECRET: undefined })).toEqual([expect.stringMatching(/MEDIA_SIGNING_SECRET/)]);
    expect(problems({ ...strong, CORS_ORIGINS: '*' })).toEqual([expect.stringMatching(/CORS_ORIGINS/)]);
    expect(problems({ ...strong, PUBLIC_BASE_URL: 'http://api.example.com' })).toEqual([expect.stringMatching(/https/)]);
    expect(problems({ ...strong, APP_ENV: 'staging', SMS_PROVIDER: 'console' })).toEqual([expect.stringMatching(/development sender/)]);
  });

  it('without a provider, requesting a code fails closed — no code is produced anywhere', async () => {
    let issued = false;
    const auth = createAuthService({
      pool: {
        query: async () => ({ rows: [] }),
        connect: async () => ({ query: async () => ((issued = true), { rows: [] }), release: () => undefined }),
      } as never,
      clock: () => new Date(),
      config: loadConfig(strong),
      sms: unconfiguredSms(),
      limiter: { consume: async () => undefined },
      log: memoryLogger().logger,
    });
    await expect(auth.requestOtp('+905321234567', '1.1.1.1')).rejects.toMatchObject({ code: 'CODE_NOT_SENT' });
    expect(issued).toBe(true); // the challenge is recorded (and rate-limited) but its code is never delivered or returned
  });
});

describe('server source', () => {
  it('contains no fixed one-time code and no development OTP shortcut', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    for (const f of files(join(__dirname, '../src'))) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toContain('246810');
      expect(src, f).not.toMatch(/MOCK_OTP|mockAdmissionApi|communityFixture/);
    }
  });
});
