/**
 * Infrastructure as files (DEC-073, DEC-081, DEC-082): the generated
 * CloudFormation template carries exactly the controls the reference policies
 * describe, and the Render Blueprint keeps secrets generated or unsynced.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..');
const generate = (extra: string[] = []) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(repo, 'infra/aws/staging-stack.mjs'),
        '--render-workspace', 'tea-abc123',
        '--render-environment', 'evm-def456',
        '--render-service', 'srv-ghi789',
        '--github-repo', 'owner/velvet',
        '--suffix', 'qa1',
        ...extra,
      ],
      { encoding: 'utf8' },
    ),
  );
const reference = (file: string) => JSON.parse(readFileSync(join(repo, 'infra/aws', file), 'utf8'));
type Statement = { Sid: string; Condition?: Record<string, Record<string, unknown>>; Action?: unknown; Resource?: unknown };
const bySid = (statements: Statement[], sid: string) => statements.find((x) => x.Sid === sid)!;

describe('CloudFormation template (infra/aws/staging-stack.mjs)', () => {
  const t = generate();
  const r = t.Resources;

  it('keeps every bucket private, encrypted, owner-enforced and TLS-only', () => {
    for (const b of ['MediaBucket', 'VerificationBucket', 'LogBucket']) {
      const p = r[b].Properties;
      expect(p.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      expect(p.OwnershipControls.Rules[0].ObjectOwnership).toBe('BucketOwnerEnforced');
      expect(p.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm).toBe('AES256');
      expect(r[b].DeletionPolicy).toBe('Retain');
    }
    for (const policy of ['MediaBucketPolicy', 'VerificationBucketPolicy', 'LogBucketPolicy']) {
      expect(bySid(r[policy].Properties.PolicyDocument.Statement, 'TlsOnly').Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
    }
  });

  it('uses the reference signature-age limits (media 15/10 min, verification 2/10 min) and the incoming/ lifecycle', () => {
    const media = r.MediaBucketPolicy.Properties.PolicyDocument.Statement;
    const verification = r.VerificationBucketPolicy.Properties.PolicyDocument.Statement;
    const age = (s: Statement) => (s.Condition as { NumericGreaterThan: { 's3:signatureAge': string } }).NumericGreaterThan['s3:signatureAge'];
    const refMedia = reference('media-bucket-policy.json').Statement;
    const refVerification = reference('verification-bucket-policy.json').Statement;
    expect(age(bySid(media, 'PresignedReadsDieWithTheirTtl'))).toBe(age(bySid(refMedia, 'PresignedReadsDieWithTheirTtl')));
    expect(age(bySid(media, 'PresignedUploadsDieWithTheirTtl'))).toBe(age(bySid(refMedia, 'PresignedUploadsDieWithTheirTtl')));
    expect(age(bySid(verification, 'ReviewerReadsLiveTwoMinutes'))).toBe(age(bySid(refVerification, 'ReviewerReadsLiveTwoMinutes')));
    expect(age(bySid(verification, 'PresignedUploadsDieWithTheirTtl'))).toBe(age(bySid(refVerification, 'PresignedUploadsDieWithTheirTtl')));
    for (const b of ['MediaBucket', 'VerificationBucket']) {
      expect(r[b].Properties.LifecycleConfiguration.Rules[0]).toMatchObject({ Prefix: 'incoming/', ExpirationInDays: 1, Status: 'Enabled' });
    }
    expect(r.VerificationBucket.Properties.LoggingConfiguration.LogFilePrefix).toBe('verification/');
  });

  it('the API role: only the one Render service; the reference permissions', () => {
    const trust = r.ApiRole.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Condition.StringEquals).toEqual({
      'oidc.render.com/tea-abc123:aud': 'sts.amazonaws.com',
      'oidc.render.com/tea-abc123:sub': 'workspace:tea-abc123:environment:evm-def456:service:srv-ghi789',
    });
    const actions = r.ApiRole.Properties.Policies[0].PolicyDocument.Statement.map((s: Statement) => [s.Sid, s.Action]);
    expect(actions).toEqual(reference('api-role-policy.json').Statement.map((s: Statement) => [s.Sid, s.Action]));
  });

  it('the storage-test role: only GitHub’s staging environment of this repository, test-shaped keys only', () => {
    const trust = r.StorageTestRole.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Condition.StringEquals).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:owner/velvet:environment:staging',
    });
    const objects = bySid(r.StorageTestRole.Properties.Policies[0].PolicyDocument.Statement, 'TestShapedKeysOnly').Resource as string[];
    expect(objects).toEqual([
      'arn:aws:s3:::velvet-staging-media-qa1/incoming/*/t*',
      'arn:aws:s3:::velvet-staging-media-qa1/member/t*',
      'arn:aws:s3:::velvet-staging-verification-qa1/incoming/*/t*',
    ]);
    // Real keys can never match: upload ids are upl_…, member ids mem_… (newId), application/ and verification/ never.
    expect(objects.some((o) => /application\/|\/verification\//.test(o.replace('velvet-staging-verification', '')))).toBe(false);
  });

  it('CORS exists only with a staging web origin, and then only PUT + content-type from it', () => {
    expect(r.MediaBucket.Properties.CorsConfiguration).toBeUndefined();
    const withWeb = generate(['--web-origin', 'https://web-staging.example.com']).Resources;
    expect(withWeb.MediaBucket.Properties.CorsConfiguration.CorsRules).toEqual([
      { Id: 'staging-web-direct-upload', AllowedOrigins: ['https://web-staging.example.com'], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], MaxAge: 600 },
    ]);
  });
});

describe('Render Blueprint (infra/render/render.yaml)', () => {
  const yaml = readFileSync(join(repo, 'infra/render/render.yaml'), 'utf8');
  it('generates every secret or leaves it unsynced; no secret value is written in the file', () => {
    for (const key of ['OTP_SECRET', 'MEDIA_SIGNING_SECRET', 'DATABASE_RUNTIME_PASSWORD', 'INTERNAL_KEY_RUNNER_SECRET', 'INTERNAL_KEY_OPS_SECRET', 'INTERNAL_KEY_REVIEWER_SECRET']) {
      expect(yaml).toMatch(new RegExp(`key: ${key}\\n\\s+generateValue: true`));
    }
    for (const key of ['ILETIMERKEZI_API_KEY', 'ILETIMERKEZI_API_HASH', 'ILETIMERKEZI_SENDER', 'NETGSM_PASSWORD', 'NETGSM_USERCODE', 'NETGSM_HEADER', 'AWS_ROLE_ARN', 'S3_BUCKET', 'S3_VERIFICATION_BUCKET', 'SMS_PROVIDER', 'CORS_ORIGINS', 'EXPO_PUBLIC_API_URL']) {
      expect(yaml).toMatch(new RegExp(`key: ${key}\\n\\s+sync: false`));
    }
    expect(yaml).not.toMatch(/key: DATABASE_URL\n/);
    expect(yaml).toMatch(/ipAllowList: \[\]/);
    expect(yaml).toMatch(/preDeployCommand: node dist\/migrate.mjs/);
    expect(yaml).toMatch(/healthCheckPath: \/health\/live/);
  });
  it('the internal key list is valid configuration: every secret generated, each key only its scopes', async () => {
    const { loadConfig } = await import('../src/config');
    const keys = JSON.parse(/key: INTERNAL_KEYS_JSON\n\s+value: '([^']+)'/.exec(yaml)![1]!) as Record<string, { secretEnv: string; scopes: string[] }>;
    expect(Object.fromEntries(Object.entries(keys).map(([id, k]) => [id, k.scopes]))).toEqual({
      runner: ['test:otp', 'test:review'],
      ops: ['retention:run', 'media:reconcile'],
      reviewer: ['review:read', 'review:write', 'review:media', 'membership:complimentary'],
    });
    for (const k of Object.values(keys)) expect(yaml).toMatch(new RegExp(`key: ${k.secretEnv}\\n\\s+generateValue: true`));
    const secrets = Object.fromEntries(Object.values(keys).map((k) => [k.secretEnv, 's'.repeat(44)]));
    const config = loadConfig({
      APP_ENV: 'staging',
      DATABASE_URL: 'postgres://u@h/d',
      DATABASE_TLS: 'require',
      OTP_SECRET: 'p'.repeat(48),
      MEDIA_SIGNING_SECRET: 'm'.repeat(48),
      INTERNAL_KEYS_JSON: JSON.stringify(keys),
      ...secrets,
      PUBLIC_BASE_URL: 'https://velvet-api-staging.onrender.com',
      S3_BUCKET: 'a',
      S3_VERIFICATION_BUCKET: 'b',
      SMS_PROVIDER: 'none',
    });
    expect(Object.keys(config.internalKeys).sort()).toEqual(['ops', 'reviewer', 'runner']);
  });

  it('the staging web app is gated, unindexed and never framed', () => {
    expect(yaml).toMatch(/name: velvet-web-staging\n\s+runtime: static/);
    expect(yaml).toMatch(/check-release-bundle\.mjs dist-staging --channel staging/);
    expect(yaml).toMatch(/name: X-Robots-Tag\n\s+value: noindex, nofollow/);
    expect(yaml).toMatch(/name: X-Frame-Options\n\s+value: DENY/);
  });
});
