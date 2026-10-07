# Infrastructure decision — staging

Which providers carry the staging stack, and why. Decision: DEC-073.
Status: **selected, not provisioned.** No account at any of these
providers has been opened for this project (see §6, "What the project owner
must create").

- **Verified on 2026-10-07** against each provider's own documentation and
  pricing pages (links inline). Prices are in the provider's currency on that
  date and will change.
- **NOT CONFIRMED** means the official documentation did not state it. It
  does not mean the capability is missing, and nothing below relies on an
  unconfirmed capability without saying so.
- Domain code is unaffected by these choices. The API talks to:
  - PostgreSQL through `DATABASE_URL`;
  - storage through `ObjectStore` (server/src/media/objectStore.ts, any
    S3-compatible service);
  - SMS through `SmsProvider` (server/src/auth/sms.ts);
  - billing through the internal `billing:write` endpoint (no provider yet).

  Vendor-specific code lives only in those adapters and in `infra/`.

Users are in Türkiye. **No provider evaluated has a cloud region in
Türkiye today:**
- Google has announced one as coming ([GCP blog](https://cloud.google.com/blog/products/infrastructure/new-google-cloud-region-coming-to-turkiye/)).
- AWS has an Istanbul *Local Zone*, not a region
  ([AWS](https://aws.amazon.com/about-aws/whats-new/2026/05/aws-local-zones-istanbul-turkiye/)).
- Azure, Scaleway, Hetzner, Koyeb, Render, Fly, DigitalOcean and Railway
  list none ([AWS regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html),
  [Azure regions](https://learn.microsoft.com/en-us/azure/reliability/regions-list),
  [Render regions](https://render.com/docs/regions)).

Frankfurt is the common EU region close to Istanbul, so every component
below sits there. Actual Istanbul → Frankfurt latency is not published by any
provider and has to be measured once staging exists.

---

## 1. API HOSTING

### SELECTED
**Render — a Docker web service in the Frankfurt region, in a Render
workspace used only for staging, on the Pro plan.** Compute plan `0.5c-512mb`
(see §1, Cost variables).

### ALTERNATIVES CONSIDERED

| | Why not (for staging now) |
|---|---|
| **Fly.io** (fra / ams) | Good fit: `release_command` runs before machines update, and the database is private by design. Its managed Postgres starts at $38/mo, and Fly lists "security patches and version upgrades" as not there yet ([Fly MPG](https://fly.io/docs/mpg/)). |
| **AWS ECS Fargate / ECS Express Mode + ALB** (eu-central-1) | Strongest controls. App Runner is closed to new customers ([AWS](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)). The load balancer alone is ≈ $19.7/mo, and the migration task has to be ordered by CI ([standalone tasks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/standalone-tasks.html)). More operations work for one service. |
| **Google Cloud Run** | No built-in pre-deploy step; a Cloud Run job must be sequenced by CI ([jobs](https://cloud.google.com/run/docs/execute/jobs)). Custom-domain mapping is Preview and not offered in europe-west3 Frankfurt ([domains](https://cloud.google.com/run/docs/mapping-custom-domains)). |
| **DigitalOcean App Platform** | Cheapest. Runtime logs are not retained without a forwarder ([logs](https://docs.digitalocean.com/products/app-platform/how-to/view-logs/)). Whether a failed `PRE_DEPLOY` job blocks the release is NOT CONFIRMED. |
| **Railway** (Amsterdam) | Usage-based billing. Config-as-code format cut off on 2026-12-01 ([Railway](https://docs.railway.com/config-as-code)). Postgres is a template container. |

### WHY SELECTED
- **Migrations before traffic, natively.** `preDeployCommand` runs after the
  build, on a separate instance, before the new version starts. A failure
  keeps the previous version serving, with a 30-minute timeout
  ([deploys](https://render.com/docs/deploys)). This is exactly the release
  step in docs/STAGING.md: `node dist/migrate.mjs`.
- **Health-gated rollout.** `healthCheckPath` gates traffic to a new
  instance and cancels a deploy that never turns healthy
  ([health checks](https://render.com/docs/health-checks)).
  - **Render also restarts a running instance that keeps failing it.** So it
    points at `/health/live`, not `/health/ready`: a restart cannot fix a
    database or storage outage, and the restart would turn the outage into a
    crash loop.
  - **Readiness is proven at start instead.** The API listens only after its
    database role, the schema ledger and storage check out.
  - **`/health/ready`** is for CI, the smoke flow and monitoring.
  - **During a rollout**, a newer release's migration makes an older instance
    report `migrations: ahead`, which is still ready (expand-first
    migrations).
- **Runs our image as is.** A Dockerfile build, with `dockerfilePath` /
  `dockerContext` for this monorepo
  ([blueprint](https://render.com/docs/blueprint-spec)). No platform SDK in
  the code.
- **Workload identity to AWS (Pro).** Render issues each service a
  short-lived, auto-rotating OIDC token. The AWS SDK picks it up through
  `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`
  ([Render OIDC](https://render.com/docs/oidc)), so the API holds **no
  long-lived storage key**. The AWS trust policy can be scoped to one
  workspace, environment and service
  (`workspace:{id}:environment:{id}:service:{id}`).
- **TLS.** Automatic certificates for the custom domain
  `api-staging.<domain>`, with HTTP redirected to HTTPS
  ([TLS](https://render.com/docs/tls)).
- **Secrets.** Environment variables and secret files, kept out of the
  blueprint with `sync: false`
  ([env vars](https://render.com/docs/configure-environment-variables),
  [blueprint](https://render.com/docs/blueprint-spec)).
- **Logs.** 14-day retention on Pro, plus syslog/HTTPS log streams
  ([logging](https://render.com/docs/logging),
  [log streams](https://render.com/docs/log-streams)).
- **Fixed monthly instance prices** ([pricing](https://render.com/pricing)).

### CURRENT LIMITATIONS
- **Network restriction on `/internal/*`.**
  - An inbound IP allow list for web services requires the Scale plan
    ($499/mo) ([blueprint: ipAllowList](https://render.com/docs/blueprint-spec)).
  - On Pro, `/internal/*` is reachable from the internet and protected by
    signed, scoped, environment-bound requests (DEC-070).
  - It can also be protected by the API's own `INTERNAL_ALLOWED_CIDRS`
    allow list (§1.1).
  - A Render *private service* (no public address) would remove internet
    exposure, but then the smoke runner must itself run inside Render. That
    is a later hardening step, not done here.
- **The migration credential is in the API's environment.**
  - The pre-deploy command runs on a separate instance, but Render does not
    document a separate environment for it (NOT CONFIRMED either way). We
    assume it shares the service's variables.
  - So `MIGRATION_DATABASE_URL` (the schema owner) is present in the API
    service's environment even though the API never connects with it. The
    API uses the least-privilege runtime role (§2) and removes
    `MIGRATION_DATABASE_URL` from `process.env` at start.
  - A full process compromise could still read the original environment.
  - The stricter alternative is a separate Render *background worker* or
    *job* holding only the migration credential, triggered by CI.
- **Shared outbound IPs.** Outbound IP ranges are shared by all Render
  services in the region; dedicated outbound IPs cost extra
  ([outbound IPs](https://render.com/docs/outbound-ip-addresses)). This
  matters for the SMS provider's IP allow list (§4).
- **Fixed region.** The region cannot change after creation
  ([regions](https://render.com/docs/regions)).
- **Short-lived signed URLs.** With OIDC, the storage credentials are
  temporary. A presigned URL dies early if the credentials that signed it
  expire first ([AWS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)).
  Our URLs live 2–15 minutes. The SDK refreshes credentials before they
  expire, but an occasional early expiry is possible and is answered by the
  normal expired-URL path (a new URL on the next request).

### Isolation from production
- **Private networks.** Render services share a private network when they
  are in the same region **and the same workspace**. On Pro, private-network
  traffic into or out of an environment can also be blocked
  ([private network](https://render.com/docs/private-network)).
- **Staging gets its own workspace.** Production, when it is created in a
  later phase, gets another. They share no database, no secrets and no
  private network. Within the staging workspace, the environment has
  `networking.isolation: enabled` and `permissions.protection: enabled`
  (infra/render/render.yaml).

### MIGRATION / EXIT RISK
- **Low.** The artefact is a standard Docker image (server/Dockerfile).
- Moving to Fly, ECS, Cloud Run or DigitalOcean changes only:
  - how `node dist/migrate.mjs` is triggered before traffic shifts
    (`release_command`, a standalone task, a job, `PRE_DEPLOY`);
  - how secrets are injected.
- **Render-specific pieces:**
  - infra/render/render.yaml;
  - the OIDC trust policy (another host needs its own identity federation,
    or scoped access keys);
  - the deploy-hook step in CI.

### COST VARIABLES
- **Workspace:** Pro, $25/mo plus compute. It is needed for OIDC, isolated
  environments, 7-day PITR and 14-day logs
  ([pricing](https://render.com/pricing)).
- **Web service:** `0.5c-512mb` $7/mo, or `1c-2g` $25/mo.
  - Image processing (sharp, ≤ 2048 px re-encode) may need 2 GB under
    concurrent uploads; measure in staging.
  - More than one instance multiplies the price.
- **Bandwidth:** 25 GB included on Pro, then $0.15/GB. Photos are served by
  storage, not the API.
- **Pipeline minutes:** used by builds and pre-deploy runs.
- **Optional extras:** dedicated outbound IPs (price on request in the
  dashboard; NOT CONFIRMED), and a Render cron job for the scheduled
  retention/reconciliation call (0.5c-512mb at $0.00016/min).

### 1.1 Network restriction for internal endpoints
`INTERNAL_ALLOWED_CIDRS` (optional) limits every `/internal/*` route to
caller addresses in the listed ranges. The address is resolved with
`TRUST_PROXY_HOPS`, so it cannot be spoofed through `X-Forwarded-For`.
Signing is never relaxed because of it: both checks apply.

GitHub-hosted CI runners have no stable address. When the allow list is on,
the smoke runner must run from an allow-listed machine; otherwise rely on the
signatures.

Do not turn the allow list on before the staging suite's proxy check passes
(docs/STAGING.md §8.1). If `TRUST_PROXY_HOPS` does not match Render's
`X-Forwarded-For`, the API would see Render's private proxy address
instead of the caller's.

---

## 2. POSTGRESQL

### SELECTED
**Render Postgres, PostgreSQL 16, Frankfurt, compute plan `0.5c-1g`, in the
same staging workspace and environment as the API. External access is
disabled with an empty IP allow list.**
- PostgreSQL 16 matches the version every test and rehearsal runs on.
  Render offers 13–18 ([create](https://render.com/docs/postgresql-creating-connecting)),
  and the major version cannot be changed after creation
  ([blueprint](https://render.com/docs/blueprint-spec)).

### ALTERNATIVES CONSIDERED

| | Why not (for staging now) |
|---|---|
| **AWS RDS for PostgreSQL** (eu-central-1) | Strongest: TLS forced by default on PG 15+, PITR up to 35 days, private subnets ([RDS SSL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html), [retention](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html)). Pairs with ECS rather than Render: Render can reach AWS privately only through AWS PrivateLink (Pro) ([private network](https://render.com/docs/private-network)). The natural production upgrade path. |
| **Fly Managed Postgres** | Private by design, TLS on by default ([MPG](https://fly.io/docs/mpg/create-and-connect/)). Roles are limited to three fixed roles, so a custom least-privilege role is NOT CONFIRMED ([cluster config](https://fly.io/docs/mpg/cluster-configuration/)). From $38/mo. |
| **Google Cloud SQL** | Accepts unencrypted connections by default (TLS-only must be configured) ([SSL](https://cloud.google.com/sql/docs/postgres/configure-ssl-instance)). Managed pooling only on Enterprise Plus ([pooling](https://cloud.google.com/sql/docs/postgres/managed-connection-pooling)). |
| **DigitalOcean Managed PostgreSQL** | Public endpoint restricted by firewall; whether it can be removed entirely is NOT CONFIRMED ([trusted sources](https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/)). |
| **Neon / Supabase** | Not evaluated in depth: both are reached over the public internet unless private networking is bought separately. That conflicts with "only the backend may reach PostgreSQL". |

### WHY SELECTED
- **Not publicly reachable.** An empty IP allow list "completely disable[s]
  external access"; same-region services connect through the internal URL
  ([create](https://render.com/docs/postgresql-creating-connecting)).
  `ipAllowList: []` is in infra/render/render.yaml.
- **TLS.** Internal connections can use TLS (self-signed certificates); the
  API connects with `DATABASE_TLS=require`. The API refuses to start in
  staging/production with TLS off (§2.1).
- **Least-privilege roles are possible.** Users created with `CREATE USER`
  are allowed and are not managed by Render
  ([credentials](https://render.com/docs/postgresql-credentials)).
- **Backups.** Continuous backups with point-in-time recovery: 7 days on Pro.
  A recovery **always creates a new instance** and never overwrites the
  original ([backups](https://render.com/docs/postgresql-backups)). That is
  exactly what the restore test needs (docs/BACKUP_AND_RECOVERY.md).
  Logical exports are available on demand and kept 7 days.
- **Same private network as the API.** No extra networking product needed.

### 2.1 Roles (DEC-074)

| Role | Created by | Used by | Can |
|---|---|---|---|
| default Render user (schema owner) | Render, at creation | the release step only (`MIGRATION_DATABASE_URL`) | DDL in `app`, `app_meta` |
| `velvet_runtime` (NOLOGIN group) | migration 0010 | — | `SELECT/INSERT/UPDATE/DELETE` on `app` tables only through explicit grants and row-level-security policies; `SELECT` on `app_meta.schema_migrations`; no DDL, no `TRUNCATE` |
| `velvet_api` (LOGIN, member of `velvet_runtime`) | the release step, from the Render-generated `DATABASE_RUNTIME_PASSWORD` (DEC-081; set as a SCRAM verifier, re-asserted on every deploy). Manual alternative: infra/postgres/create-runtime-login.sql | the API (connection derived from the owner's internal URL) | what `velvet_runtime` can |

At start in staging/production, the API refuses to run if its database role:
- is a superuser;
- can bypass row-level security; or
- owns the `app` schema.

So the API cannot accidentally run as the owner (server/src/db/role.ts).

### CURRENT LIMITATIONS
- **Internal TLS certificates are self-signed**, so `verify-full` is not
  possible on the internal URL. The connection is encrypted but the server
  certificate is not verified. Recorded as a limitation, not hidden.
- **No custom roles on the default instance's superuser.** Whether the
  default Render user is a PostgreSQL superuser is NOT CONFIRMED. Migration
  0010 needs the right to create a NOLOGIN role (CREATEROLE). If the
  provider refuses, the migration fails loudly rather than leave the API on
  the owner role.
- **PgBouncer is not enabled.** Render's pooler runs in transaction mode and
  enabling it restarts the database
  ([pooling](https://render.com/docs/postgresql-connection-pooling)). The
  API pools connections itself (`DATABASE_POOL_MAX`, default 10). It uses
  only transaction-scoped advisory locks, so it would also work behind a
  transaction-mode pooler; the migration runner's session lock would not,
  so migrations must use the direct internal URL.
- **Connection cap.** `0.5c-1g` allows at most 100 connections
  ([compute plans](https://render.com/docs/compute-plans)): instances ×
  `DATABASE_POOL_MAX` must stay well under it.
- **`pg_dump` from outside Render** needs external access, which is
  disabled. Run it from inside the workspace (a one-off job or shell), or
  use the dashboard export. Render's sample dump commands use `-n public`.
  This schema lives in `app` and `app_meta`, so dumps must name those
  schemas (docs/BACKUP_AND_RECOVERY.md).

### MIGRATION / EXIT RISK
- **Low.** Standard PostgreSQL 16, plain SQL migrations, no extensions
  beyond core.
- **To leave:** take a logical export (or `pg_dump -n app -n app_meta`),
  restore it into the new provider's PostgreSQL 16+, recreate the roles,
  and re-run `migrate --verify`.

### COST VARIABLES
- **Compute plan:** `0.5c-1g` $19/mo; `1c-2g` $40/mo.
- **Storage:** $0.30/GB-month.
- **PITR window:** 7 days on Pro, included.
- **Optional:** read replicas and high availability (not used in staging).
- **Recovery test:** a recovery instance is billed while it exists; delete
  it after the test.

---

## 3. OBJECT STORAGE

### SELECTED
**AWS S3, region eu-central-1 (Frankfurt), in an AWS account used only for
staging, with three private buckets: `media`, `verification`, and an access-log
bucket.** The API reaches S3 with an IAM role assumed through Render's OIDC
(no stored access keys).

### ALTERNATIVES CONSIDERED

| | Why not (for staging now) |
|---|---|
| **Cloudflare R2 (EU jurisdiction)** | Free egress, and the only provider documenting that a signed `Content-Type` mismatch is refused ([R2 presigned](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)). But: no bucket policies, versioning or `PutBucketLogging` ([R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)), and object-read logs exist only for buckets **without** a jurisdiction ([data access logs](https://developers.cloudflare.com/r2/buckets/data-access-logs/)). So the verification bucket could have EU residency or read logs, not both. Strong candidate for `media` later if egress dominates. |
| **Backblaze B2 (EU Central)** | Prefix-scoped keys, access logs, default encryption. Its S3 lifecycle "Expiration" hides objects before deleting them, so `incoming/` purges take ≥ 2 days ([B2 lifecycle](https://www.backblaze.com/apidocs/s3-put-lifecycle-configuration)). Maximum presign expiry NOT CONFIRMED. |
| **Google Cloud Storage (XML API)** | CopyObject, lifecycle and CORS through the S3 SDK are NOT CONFIRMED (GCS uses its own formats) ([lifecycle](https://docs.cloud.google.com/storage/docs/lifecycle)). Expect adapter changes. |
| **DigitalOcean Spaces, Scaleway, Hetzner, Tigris** | Each lacks something we rely on: per-bucket keys that can't be combined with bucket policies (DO); no default encryption and no access logging (Hetzner); access logging NOT CONFIRMED (Scaleway, Tigris). Render's own object storage is in alpha ([Render](https://feedback.render.com/features/p/cloud-object-storage)). |

### WHY SELECTED
It is the only provider where every control the media design needs is
documented:
- **Public access blocked by default.** All four Block Public Access
  settings are on and ACLs are disabled for new buckets
  ([create bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html)).
- **Default encryption at rest.** SSE-S3 for all new objects, at no charge
  ([encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-encryption-faq.html)).
- **Per-bucket and per-prefix IAM.** The verification bucket is the
  strictest:
  - its own bucket policy;
  - TLS only;
  - only the staging API role;
  - presigned reads refused once their signature is older than 2 minutes
    (`s3:signatureAge`, [presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html),
    [policy examples](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-policies-s3.html)).
  - Policies are in infra/aws/.
- **Lifecycle by prefix.** `incoming/` objects expire after 1 day in both
  buckets
  ([lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketLifecycleConfiguration.html)).
- **CORS on the bucket**, limited to the staging web origin and `PUT`
  ([CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)).
- **Server access logs that include failed authentications** (written
  within hours), on the verification bucket at least
  ([logging](https://docs.aws.amazon.com/AmazonS3/latest/userguide/logging-with-S3.html)).
- **The reference S3 implementation.** The adapter's SigV4 presigning,
  CopyObject, HeadObject and ListObjectsV2 behave as the SDK expects.
- **A later in-country option.** The Istanbul Local Zone offers S3 (as
  directory buckets with fewer features) if data residency in Türkiye
  becomes a requirement
  ([AWS](https://aws.amazon.com/about-aws/whats-new/2026/05/aws-local-zones-istanbul-turkiye/),
  [directory buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html)).

### CURRENT LIMITATIONS
- **Signed `Content-Length` / `Content-Type` enforcement on a presigned
  `PUT` is not stated in AWS documentation** (NOT CONFIRMED). SigV4 includes
  every signed header in the signature, so a mismatch should fail. The real
  provider test (server/test/storage.provider.test.ts) checks it explicitly:
  wrong type, wrong length, altered signature, expired signature. Until that
  test passes against the real bucket, signed uploads are **not** marked
  verified.
- **Lifecycle deletion is asynchronous.** An `incoming/` object can outlive
  one day. The API's own sweep (`incoming_swept_at`) and the reconciliation
  job (§3.1) remain the primary controls.
- **No versioning or Object Lock on `media`/`verification`.** Versioning
  would keep deleted photos as non-current versions and defeat account
  deletion. As a result, **objects are not backed up**; a deleted or lost
  object cannot be restored (docs/BACKUP_AND_RECOVERY.md).
- **Egress is charged** ($0.09/GB beyond the free 100 GB/month,
  [pricing](https://aws.amazon.com/s3/pricing/)). Presigned per-viewer URLs
  defeat CDN caching.
- **OIDC needs Render Pro**, and the trust policy must be scoped to the
  staging service subject. Without Pro, the fallback is an IAM user access
  key scoped to the staging buckets, stored as a Render secret and rotated
  manually (documented in infra/aws/README.md).

### 3.1 Media reconciliation
A storage-agnostic job (`POST /internal/media/reconcile`, scope
`media:reconcile`) lists both buckets with ListObjectsV2 and compares them
with the database. It is dry-run by default. See docs/MEDIA_ARCHITECTURE.md §7.

### MIGRATION / EXIT RISK
- **Moderate.** The data is plain objects under opaque keys. Copying them to
  another S3-compatible store is a bulk copy.
- **AWS-specific pieces:**
  - the IAM/bucket policies and the OIDC role (infra/aws/);
  - `s3:signatureAge` (other providers lack an equivalent);
  - server access logs.
- **Unaffected:** the adapter is generic S3, so R2/B2/Spaces need only
  `S3_ENDPOINT` / `S3_REGION` / path-style configuration.
- AWS offers free data transfer out when leaving, on request
  ([AWS](https://aws.amazon.com/blogs/aws/free-data-transfer-out-to-internet-when-moving-out-of-aws/)).

### COST VARIABLES
All prices are Frankfurt, from the AWS price list published 2026-09-28
([price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/eu-central-1/index.csv)):
- **Storage:** $0.0245/GB-month.
- **Requests:** PUT/COPY/LIST $0.0054 per 1,000; GET/HEAD $0.0043 per 10,000.
  Reconciliation listing is billed as LIST.
- **Egress:** $0.09/GB after 100 GB/month free.
- **Server access log storage:** billed as storage.
- **CloudTrail data events:** optional, paid.
- **Staging volume:** a few GB of test photos, so cents per month.

---

## 4. SMS

### SELECTED
**Netgsm "OTP SMS"** for Türkiye (+90) numbers, through its current REST
endpoint `POST https://api.netgsm.com.tr/sms/rest/v2/otp` (JSON, HTTP Basic
authentication with an **API sub-user**)
([Netgsm API — OTP](https://www.netgsm.com.tr/dokuman/#otp-sms)). Staging gets its own API sub-user and
password, never shared with production.

The adapter was moved from the XML endpoint to REST v2 in this phase. Netgsm
now lists the XML endpoint (`/sms/send/otp`) under "old versions"
([old versions](https://www.netgsm.com.tr/dokuman/#eski-versiyonlar)).

### ALTERNATIVES CONSIDERED

| | Why not (for staging now) |
|---|---|
| **İleti Merkezi** | Strong alternative. Individuals may hold a sender header, header check takes 1 business day, delivery-report **webhooks**, undelivered SMS not charged, 100 free credits ([documents](https://www.iletimerkezi.com/toplu-sms-gerekli-evraklar), [pricing](https://www.iletimerkezi.com/toplu-sms-fiyatlari), [webhook](https://www.toplusmsapi.com/sms/rapor/liste/webhook)). No OTP-specific endpoint: single-recipient immediate API messages are prioritised automatically ([OTP](https://www.iletimerkezi.com/otp-sms)). **The choice if the project has no business registration yet.** |
| **Twilio (Programmable Messaging / Verify)** | Türkiye requires a pre-registered alphanumeric sender (≈ 2 weeks; unregistered senders are blocked from 18 Nov 2026) ([Twilio Türkiye](https://www.twilio.com/en-us/guidelines/tr/sms)). Verify test credentials don't exist ([Twilio](https://www.twilio.com/en-us/blog/test-verify-no-rate-limits)). Priced in USD. The route for non-+90 numbers later. |
| **Verimor** | Sender headers only for İYS-registered businesses; IP allow list mandatory ([Verimor API](https://github.com/verimor/SMS-API/blob/master/user_guide.md)). |
| **Vonage, Infobip** | Sender pre-registration mandatory; Infobip direct customers need a local entity ([Vonage](https://api.support.vonage.com/hc/en-us/articles/204017543-Turkey-SMS-Features-and-Restrictions), [Infobip](https://www.infobip.com/docs/essentials/mena-registration/t%C3%BCrkiye-letter-of-authorization-loa-guidelines)). |

### WHY SELECTED
- **A documented, separate OTP product** ([Netgsm OTP](https://www.netgsm.com.tr/dokuman/#otp-sms)):
  - priority delivery directly to the three Turkish networks, delivered
    within 3 minutes;
  - API only;
  - no İYS, blacklist or duplicate filtering on OTP sends, so our own rate
    limits are the abuse control.
- **Operator licence.** Netgsm sells under a BTK operator licence
  ([product](https://www.netgsm.com.tr/sms/otp-sms)).
- **Credentials and network.** An API sub-user per environment, plus an
  optional source-IP allow list
  ([settings](https://www.netgsm.com.tr/dokuman/#ayarlar)).
- **Delivery reports** by job id through `POST /sms/rest/v2/report`
  ([report](https://www.netgsm.com.tr/dokuman/#json-post-rapor)). Used by
  the staging OTP check to confirm delivery without reading the code.
- **Prepaid TL packages:** 1,000 OTP = 316 TL including taxes
  ([product](https://www.netgsm.com.tr/sms/otp-sms)).
- **Regulatory basis.** Messages about a membership need no prior consent
  and must not promote anything (Regulation on Commercial Communication,
  Art. 6(2), [Resmî Gazete 2015-07-15](https://www.resmigazete.gov.tr/eskiler/2015/07/20150715-4.htm)).
  - The OTP text is a bare verification message.
  - No official İYS text names OTPs explicitly, so treating them as outside
    İYS is an inference from that article (NOT CONFIRMED by İYS itself).

### CURRENT LIMITATIONS
- **No sandbox** is documented, so every send is real and paid.
  - Automated staging tests use designated test numbers routed to the
    internal outbox (`SMS_TEST_NUMBERS`).
  - Real delivery is verified against a small set of project-owned SIMs
    (`npm run staging:otp`, an operator-assisted check).
- **Message format.** One segment, ASCII only (no Turkish characters),
  ≤ 155 characters with an alphanumeric header
  ([OTP](https://www.netgsm.com.tr/dokuman/#otp-sms)). The configuration
  refuses a template that breaks this when Netgsm is selected.
- **Turkish mobile numbers only**, and not KKTC numbers
  ([product](https://www.netgsm.com.tr/sms/otp-sms)). Which +90 prefixes
  belong to KKTC is NOT CONFIRMED, so they are not pre-filtered. Netgsm
  answers with a number error and the applicant sees "Check the number".
- **Delivery reports are polling only**; there is no SMS webhook.
- **Account requirements.**
  - A business registration is needed: a sole proprietorship with a tax
    certificate, or a company
    ([documents](https://bilgibankasi.netgsm.com.tr/abonelik-islemleri/abonelik-icin-gerekli-belgeler)).
    Whether a private individual can open an account is NOT CONFIRMED.
  - Sender header approval runs through the applicant's KEP address
    ([header](https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi)).
  - Since 2026-04-01, panel access needs e-İmza; API sends are exempt
    ([e-İmza](https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/sms-gonderimlerinde-e-imza-kullanimi)).
- **Shared outbound IPs.** Render's outbound IPs are shared with other
  Render customers in the region. A Netgsm IP allow list built on them is
  weak unless dedicated outbound IPs are bought (§1).
- **No status page** found (NOT CONFIRMED). Outages surface as
  `PROVIDER_UNAVAILABLE`, which the applicant sees as "We couldn't send a
  code right now".

### MIGRATION / EXIT RISK
- **Low in code:** one adapter behind `SmsProvider`, and `routeSms` can send
  +90 elsewhere.
- **Operational:**
  - Packages are non-refundable, non-transferable and valid one year
    ([product](https://www.netgsm.com.tr/sms/otp-sms)).
  - Each provider approves sender headers separately, with its own KEP and
    document process.

### COST VARIABLES
- **OTP package size**, including taxes:
  - 1,000 = 316 TL;
  - 5,000 = 1,203 TL;
  - 10,000 = 1,999 TL (new subscriptions only).
- **Resend rate.** The app allows a resend after the cool-down, and each
  resend is a paid SMS.
- **Failed sends.** Whether undelivered OTPs are charged is NOT CONFIRMED.
- **Dedicated outbound IP** at Render, if the IP allow list is used.

---

## 5. What stays out of domain code
- **Provider names** appear only in configuration, adapters (`netgsmSms`,
  `s3ObjectStore`), infra/ and docs.
- **The domain** sees `SmsProvider`, `ObjectStore`, `Pool` and the internal
  billing endpoint.
- **Switching a provider** means: change environment variables, add an
  adapter if the protocol differs, and update this file and DECISIONS.md.

## 6. What the project owner must create
This phase cannot go further without these. Nothing here is a
secret to paste into chat: each value goes into the provider's secret
store, set by the owner or through a CI secret.

| # | What | Notes |
|---|---|---|
| 1 | A **domain** and DNS access | optional: staging works on Render's `…onrender.com` address (DEC-081) |
| 2 | A **Render account**, a **staging workspace** on **Pro** | the GitHub repository connected to it |
| 3 | An **AWS account for staging** | ideally its own account in an AWS Organization; billing alerts on |
| 4 | **İleti Merkezi** individual account (DEC-085) — or Netgsm once a company exists | API access on; an approved sender name; (Netgsm: API sub-user, KEP header, OTP package) |
| 5 | **Two or more project-owned Turkish SIMs** for the real OTP check | never personal numbers of applicants |
| 6 | A **private GitHub repository** with Actions, and an environment `staging` | holds the deploy hook, the Render API key and the runner key; the Claude GitHub connection must be allowed to access it |
| 7 | **One iPhone and one Android phone** with the staging build installed | for device, VoiceOver/TalkBack and font-scaling QA |
| 8 | An **Expo / EAS account** | staging builds; Android internal APK |
| 9 | An **Apple Developer Program** membership (individual) | the iPhone staging build through TestFlight external testing (DEC-086); no App Store release |

The step-by-step order is in docs/STAGING.md §7.
