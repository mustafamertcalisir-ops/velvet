# Staging object storage on AWS S3 (Frankfurt)

Decision: DEC-073 (docs/INFRASTRUCTURE_DECISION.md §3), DEC-081/DEC-082 (no
access keys anywhere; real-provider checks run where the credentials live).

## The one-file path (recommended)

`staging-stack.mjs` generates **one CloudFormation template** holding every
bucket, role and policy below. All inputs are identifiers, not secrets.

1. **AWS account.** A staging account (ideally its own account in an AWS
   Organization), region `eu-central-1`, a billing alarm.
2. **Identity providers** (IAM → Identity providers → Add provider → OpenID
   Connect; audience `sts.amazonaws.com` for both):
   - `https://oidc.render.com/<Render workspace id, tea-…>` — Render OIDC (Pro);
   - `https://token.actions.githubusercontent.com` — GitHub Actions.
3. **Generate the template** (Claude does this once the ids are known):

   ```sh
   node infra/aws/staging-stack.mjs \
     --render-workspace tea-… --render-environment evm-… --render-service srv-… \
     --github-repo <owner>/<repo> --suffix <short unique suffix> \
     [--web-origin https://<staging web origin>] [--break-glass-role <role>] \
     > infra/aws/out/velvet-staging-storage.json
   ```

   It is validated with `cfn-lint`. `infra/aws/out/` is git-ignored.
4. **Create the stack**: CloudFormation → Create stack → Upload a template
   file → `velvet-staging-storage.json` → acknowledge IAM resources → Create.
5. **Outputs → configuration**:
   - Render (API service): `AWS_ROLE_ARN` = `ApiRoleArn`, `S3_BUCKET`,
     `S3_VERIFICATION_BUCKET`. Render sets `AWS_WEB_IDENTITY_TOKEN_FILE` itself;
     `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` stay **empty**.
   - GitHub Environment `staging` (variables): `AWS_STORAGE_TEST_ROLE_ARN` =
     `StorageTestRoleArn`, `S3_BUCKET`, `S3_VERIFICATION_BUCKET`, and
     `STAGING_WEB_ORIGIN` if one was given.
6. **Prove it**: Actions → `staging-checks` → `storage`. Storage is **not**
   verified until that passes against these buckets.

## What the stack creates

| Resource | What |
|---|---|
| `velvet-staging-media-<suffix>` | application and member photos, and their raw uploads (`incoming/`) |
| `velvet-staging-verification-<suffix>` | identity photos only; stricter policy; server access logs on |
| `velvet-staging-logs-<suffix>` | the verification bucket's access logs (written by the S3 logging service only) |
| `velvet-staging-api` | role assumable **only** by the Render staging API service (OIDC subject `workspace:…:environment:…:service:…`) |
| `velvet-staging-storage-test` | role assumable **only** by GitHub Actions in this repository's `staging` environment; objects whose key segment starts with `t` + hex (`incoming/*/t*`, `member/t*`) — real upload ids are `upl_…` and member ids `mem_…`, so it can never touch a real photo — plus the readiness probe key and listing |

Every bucket: Block Public Access (all four), ACLs disabled
(BucketOwnerEnforced), SSE-S3, TLS-only, retained if the stack is deleted.

Bucket policies (media / verification): only the two roles above (and an
optional break-glass role) may touch objects; presigned **reads** are refused
when their signature is older than **15 min** (media) / **2 min**
(verification); presigned **uploads** older than **10 min** (both).
Lifecycle: `incoming/` expires after 1 day in both buckets (raw uploads still
carry metadata; the API's own sweep is the first line).

CORS: only with `--web-origin`, and then only `PUT` with `content-type` from
that origin. Without a staging web build there is **no CORS rule at all** —
native apps do not use CORS. `staging-checks → storage` checks it in a real
browser either way.

## Reference files (manual CLI path)

The JSON files here mirror the generated template for anyone applying the
pieces by hand (`aws s3api put-bucket-policy …`); placeholders are `${NAME}`.
`staging-stack.mjs` is authoritative (server/test/infra.test.ts keeps them in
step).

| File | Mirrors |
|---|---|
| `trust-policy.json` | the API role's trust (Render OIDC, one service) |
| `api-role-policy.json` | the API role's permissions |
| `media-bucket-policy.json`, `verification-bucket-policy.json` | the bucket policies (the generated ones also admit the storage-test role) |
| `lifecycle.json`, `cors.json`, `logging-verification.json` | lifecycle, CORS, access logging |

## Without Render Pro (fallback, not recommended)

An IAM **user** with only the API role's permissions, its access key in
`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` as Render secrets, and that user's
ARN in both bucket policies. The key is long-lived: rotate it every 90 days,
and immediately if exposed.

## Readiness and `ListBucket`

`/health/ready` checks storage with a `HeadObject` on
`incoming/healthcheck/probe.bin`, which never exists. With `s3:ListBucket`, S3
answers 404 (reachable); without it, 403 (not ready). Keep the list
permission.
