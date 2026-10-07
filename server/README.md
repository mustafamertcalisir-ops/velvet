# API — production backend

Node.js + TypeScript (Hono) on PostgreSQL 16. Owns admission decisions,
activation, introductions, reactions, matches, conversations, blocks,
reports, Dating compatibility, account lifecycle, media and audit.
Implements the app's ports (AdmissionApi, MemberApi) over the shared `/v1`
contract.

Docs: `../docs/BACKEND_ARCHITECTURE.md`, `../docs/API_CONTRACT.md`,
`../docs/SECURITY_MODEL.md`, `../docs/MEDIA_ARCHITECTURE.md`,
`../docs/DATA_RETENTION.md`, `../docs/STAGING.md`, `../docs/SMS_PROVIDER.md`,
`../docs/BACKUP_AND_RECOVERY.md`, `../docs/PRIVACY_BOUNDARIES.md`,
`../docs/DATING_COMPATIBILITY.md`.

```bash
npm install
npm run typecheck
npm test                      # real PostgreSQL: ephemeral cluster, or TEST_DATABASE_URL
npm run build                 # dist/: main · migrate · smoke · staging-suite · qa-seed · staging-otp-check · log-scan · ops

# local development (migrates at start, console SMS, local storage)
DATABASE_URL=postgres://… APP_ENV=development DEV_SEED=1 npm run dev

# release step (staging/production): migrate as the schema OWNER, then verify
MIGRATION_DATABASE_URL=postgres://owner… DATABASE_TLS=require node dist/migrate.mjs
MIGRATION_DATABASE_URL=postgres://owner… DATABASE_TLS=require node dist/migrate.mjs --verify
# the API itself connects as the runtime login (infra/postgres/create-runtime-login.sql)

npm run rehearse:staging      # LOCAL staging-shaped rehearsal: TLS PG, runtime role, smoke, suites, seed,
                              # ops, faults, backup/restore, log review (not a deployment)

# against a deployed staging API (docs/STAGING.md; STAGING_* environment, QA accounts only)
node dist/smoke.mjs
node dist/staging-suite.mjs before-restart   # … restart … then: after-restart
node dist/qa-seed.mjs seed | list | otp <number> | remove
node dist/staging-otp-check.mjs              # real SMS, operator-assisted, project-owned SIM
node dist/log-scan.mjs api.log --canaries .staging-canaries.json
node dist/ops.mjs retention [--dry-run] | reconcile [--repair]   # scheduled operations (OPS_* environment)
npm run docs:security         # regenerate the endpoint table in docs/SECURITY_MODEL.md
```

Configuration: environment only (`.env.example` lists every name; no values
are committed). Point the app at a local API:
`EXPO_PUBLIC_BACKEND=http EXPO_PUBLIC_API_URL=http://127.0.0.1:8787 npx expo start`.
Release builds always use the API (`EXPO_PUBLIC_API_URL` must be https).

Reviewer actions, billing confirmations, safety tooling and the retention
run are internal endpoints (`/internal/*`) that accept only signed requests
from scoped keys; there is no dashboard.
