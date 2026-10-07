#!/usr/bin/env node
/**
 * Generates the ONE CloudFormation template for staging object storage
 * (DEC-073, DEC-082): three private buckets, two roles, every policy from
 * this folder — so the owner uploads one file in the CloudFormation console
 * instead of running a dozen CLI commands.
 *
 *   node infra/aws/staging-stack.mjs \
 *     --render-workspace tea-… --render-environment evm-… --render-service srv-… \
 *     --github-repo <owner>/<repo> --suffix <3–20 lower-case letters/digits> \
 *     [--web-origin https://…] [--break-glass-role <role name>] \
 *     > infra/aws/out/velvet-staging-storage.json
 *
 * Every value is an identifier, not a secret (the IAM condition keys must be
 * literal, so they are written in rather than passed as stack parameters).
 * Prerequisites in the AWS account (IAM → Identity providers → Add provider,
 * OpenID Connect, audience sts.amazonaws.com):
 *   - https://oidc.render.com/<render workspace id>        (Render OIDC, Pro)
 *   - https://token.actions.githubusercontent.com          (GitHub Actions)
 *
 * What it creates:
 *   velvet-staging-media-<suffix>         application/member photos + their raw uploads
 *   velvet-staging-verification-<suffix>  identity photos only (stricter policy, access-logged)
 *   velvet-staging-logs-<suffix>          the verification bucket's server access logs
 *   velvet-staging-api                    role ONLY the Render staging API service can assume
 *   velvet-staging-storage-test           role ONLY GitHub Actions in this repository's
 *                                         "staging" environment can assume, limited to
 *                                         test-shaped keys (t<hex>…) — never a real object
 * All buckets: Block Public Access on, ACLs off, SSE-S3, TLS-only. No access keys exist.
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const ws = arg('render-workspace');
const envId = arg('render-environment');
const svc = arg('render-service');
const repo = arg('github-repo');
const ghEnv = arg('github-environment', 'staging');
const suffix = arg('suffix');
const webOrigin = (arg('web-origin', '') ?? '').replace(/\/+$/, '');
const breakGlass = arg('break-glass-role', '');

const problems = [];
if (!/^tea-[a-z0-9]+$/.test(ws ?? '')) problems.push('--render-workspace tea-… (Render workspace id)');
if (!/^evm-[a-z0-9]+$/.test(envId ?? '')) problems.push('--render-environment evm-… (the staging environment id)');
if (!/^srv-[a-z0-9]+$/.test(svc ?? '')) problems.push('--render-service srv-… (velvet-api-staging)');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) problems.push('--github-repo owner/repo');
if (!/^[a-z0-9-]{3,20}$/.test(suffix ?? '')) problems.push('--suffix (3–20 lower-case letters, digits, -; makes bucket names globally unique)');
if (webOrigin && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(webOrigin)) problems.push('--web-origin must be https://host');
if (breakGlass && !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(breakGlass)) problems.push('--break-glass-role must be an IAM role name');
if (problems.length) {
  console.error(`Missing or invalid:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const account = { Ref: 'AWS::AccountId' };
const sub = (s) => ({ 'Fn::Sub': s });
const media = `velvet-staging-media-${suffix}`;
const verification = `velvet-staging-verification-${suffix}`;
const logs = `velvet-staging-logs-${suffix}`;
const arn = (b, k = '') => `arn:aws:s3:::${b}${k}`;
const renderHost = `oidc.render.com/${ws}`;
const githubHost = 'token.actions.githubusercontent.com';
const allowedPrincipals = [sub('arn:aws:iam::${AWS::AccountId}:role/velvet-staging-api'), sub('arn:aws:iam::${AWS::AccountId}:role/velvet-staging-storage-test')];
if (breakGlass) allowedPrincipals.push(sub(`arn:aws:iam::\${AWS::AccountId}:role/${breakGlass}`));

const privateBucket = (name, extra = {}) => ({
  Type: 'AWS::S3::Bucket',
  DeletionPolicy: 'Retain',
  UpdateReplacePolicy: 'Retain',
  Properties: {
    BucketName: name,
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    ...extra,
  },
});
// Raw uploads still carry their metadata: a second line behind the API's own sweep (MEDIA_ARCHITECTURE.md §1).
const lifecycle = {
  LifecycleConfiguration: {
    Rules: [{ Id: 'raw-uploads-expire', Status: 'Enabled', Prefix: 'incoming/', ExpirationInDays: 1, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }],
  },
};
// Only the staging WEB origin needs CORS (native apps do not use it); without one, no rule at all.
const cors = webOrigin
  ? { CorsConfiguration: { CorsRules: [{ Id: 'staging-web-direct-upload', AllowedOrigins: [webOrigin], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], MaxAge: 600 }] } }
  : {};

const tlsOnly = (b) => ({
  Sid: 'TlsOnly',
  Effect: 'Deny',
  Principal: '*',
  Action: 's3:*',
  Resource: [arn(b), arn(b, '/*')],
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
});
const onlyKnownRoles = (b) => ({
  Sid: 'OnlyTheStagingRolesTouchObjects',
  Effect: 'Deny',
  Principal: '*',
  Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
  Resource: arn(b, '/*'),
  Condition: { ArnNotEquals: { 'aws:PrincipalArn': allowedPrincipals } },
});
const signatureAge = (sid, b, action, ms) => ({
  Sid: sid,
  Effect: 'Deny',
  Principal: '*',
  Action: action,
  Resource: arn(b, '/*'),
  Condition: { StringEquals: { 's3:authType': 'REST-QUERY-STRING' }, NumericGreaterThan: { 's3:signatureAge': String(ms) } },
});

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: `Velvet STAGING object storage (generated by infra/aws/staging-stack.mjs; Render ${svc}, GitHub ${repo}:${ghEnv}). No public access, no access keys.`,
  Resources: {
    LogBucket: privateBucket(logs),
    LogBucketPolicy: {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: { Ref: 'LogBucket' },
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            tlsOnly(logs),
            {
              Sid: 'S3ServerAccessLogsFromTheVerificationBucket',
              Effect: 'Allow',
              Principal: { Service: 'logging.s3.amazonaws.com' },
              Action: 's3:PutObject',
              Resource: arn(logs, '/verification/*'),
              Condition: { ArnLike: { 'aws:SourceArn': arn(verification) }, StringEquals: { 'aws:SourceAccount': account } },
            },
          ],
        },
      },
    },
    MediaBucket: privateBucket(media, { ...lifecycle, ...cors }),
    VerificationBucket: {
      ...privateBucket(verification, { ...lifecycle, ...cors, LoggingConfiguration: { DestinationBucketName: { Ref: 'LogBucket' }, LogFilePrefix: 'verification/' } }),
      DependsOn: 'LogBucketPolicy',
    },
    MediaBucketPolicy: {
      Type: 'AWS::S3::BucketPolicy',
      DependsOn: ['ApiRole', 'StorageTestRole'],
      Properties: {
        Bucket: { Ref: 'MediaBucket' },
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            tlsOnly(media),
            onlyKnownRoles(media),
            signatureAge('PresignedReadsDieWithTheirTtl', media, 's3:GetObject', 900000),
            signatureAge('PresignedUploadsDieWithTheirTtl', media, 's3:PutObject', 600000),
          ],
        },
      },
    },
    VerificationBucketPolicy: {
      Type: 'AWS::S3::BucketPolicy',
      DependsOn: ['ApiRole', 'StorageTestRole'],
      Properties: {
        Bucket: { Ref: 'VerificationBucket' },
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            tlsOnly(verification),
            onlyKnownRoles(verification),
            signatureAge('ReviewerReadsLiveTwoMinutes', verification, 's3:GetObject', 120000),
            signatureAge('PresignedUploadsDieWithTheirTtl', verification, 's3:PutObject', 600000),
          ],
        },
      },
    },
    ApiRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: 'velvet-staging-api',
        Description: 'Assumed ONLY by the Render staging API service through Render OIDC (no stored keys).',
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'RenderStagingApiOnly',
              Effect: 'Allow',
              Principal: { Federated: sub(`arn:aws:iam::\${AWS::AccountId}:oidc-provider/${renderHost}`) },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  [`${renderHost}:aud`]: 'sts.amazonaws.com',
                  [`${renderHost}:sub`]: `workspace:${ws}:environment:${envId}:service:${svc}`,
                },
              },
            },
          ],
        },
        Policies: [
          {
            PolicyName: 'velvet-staging-api-storage',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                { Sid: 'MediaObjects', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [arn(media, '/incoming/*'), arn(media, '/application/*'), arn(media, '/member/*')] },
                { Sid: 'VerificationObjects', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [arn(verification, '/incoming/*'), arn(verification, '/verification/*')] },
                // Reconciliation lists both buckets; readiness needs a 404 (not 403) for a missing key.
                { Sid: 'ListForReconciliationAndReadiness', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [arn(media), arn(verification)] },
              ],
            },
          },
        ],
      },
    },
    StorageTestRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: 'velvet-staging-storage-test',
        Description: `Assumed ONLY by GitHub Actions in ${repo}, environment ${ghEnv}: the real-provider storage test (test-shaped keys only).`,
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'GitHubStagingEnvironmentOnly',
              Effect: 'Allow',
              Principal: { Federated: sub(`arn:aws:iam::\${AWS::AccountId}:oidc-provider/${githubHost}`) },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  [`${githubHost}:aud`]: 'sts.amazonaws.com',
                  [`${githubHost}:sub`]: `repo:${repo}:environment:${ghEnv}`,
                },
              },
            },
          ],
        },
        Policies: [
          {
            PolicyName: 'velvet-staging-storage-test-keys',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  // The test writes only keys whose last segments start with "t" + hex: real upload ids are "upl_…",
                  // real member ids "mem_…", so this role can never read, write or delete a real photo.
                  Sid: 'TestShapedKeysOnly',
                  Effect: 'Allow',
                  Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                  Resource: [arn(media, '/incoming/*/t*'), arn(media, '/member/t*'), arn(verification, '/incoming/*/t*')],
                },
                // The readiness probe key (it never exists): HeadObject answers 404 only with read permission on it.
                { Sid: 'ReadinessProbeKey', Effect: 'Allow', Action: 's3:GetObject', Resource: arn(media, '/incoming/healthcheck/probe.bin') },
                { Sid: 'ListBothBuckets', Effect: 'Allow', Action: 's3:ListBucket', Resource: [arn(media), arn(verification)] },
              ],
            },
          },
        ],
      },
    },
  },
  Outputs: {
    ApiRoleArn: { Description: 'Render: AWS_ROLE_ARN', Value: { 'Fn::GetAtt': ['ApiRole', 'Arn'] } },
    StorageTestRoleArn: { Description: 'GitHub (staging environment variable): AWS_STORAGE_TEST_ROLE_ARN', Value: { 'Fn::GetAtt': ['StorageTestRole', 'Arn'] } },
    MediaBucket: { Description: 'Render and GitHub: S3_BUCKET', Value: { Ref: 'MediaBucket' } },
    VerificationBucket: { Description: 'Render and GitHub: S3_VERIFICATION_BUCKET', Value: { Ref: 'VerificationBucket' } },
    LogBucket: { Description: 'Server access logs of the verification bucket', Value: { Ref: 'LogBucket' } },
  },
};
process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
