// Production build: ESM bundles for Node. The shared domain (../src) is
// bundled in through the "@/..." tsconfig path; npm dependencies stay external.
//
//   dist/main.mjs     the API
//   dist/migrate.mjs  the release migration step (`node dist/migrate.mjs [--verify]`)
//   dist/smoke.mjs              the staging smoke flow (docs/STAGING.md §5)
//   dist/staging-suite.mjs      the deployed-staging suites (docs/STAGING.md §8)
//   dist/qa-seed.mjs            the staging QA seed (docs/STAGING.md §4)
//   dist/staging-otp-check.mjs  the operator-assisted real SMS check (docs/STAGING.md §8.2)
//   dist/log-scan.mjs           the log review (docs/STAGING.md §9)
//   dist/ops.mjs                scheduled operations: retention, media reconciliation (docs/STAGING.md §4)
//   dist/db-check.mjs           read-only database verification inside the platform (docs/STAGING.md §8.5)
//   dist/review-fixture.mjs     the reviewer side of a real-SIM journey, from CI (docs/STAGING.md §8.4)
//   dist/velvet-review.mjs      the membership team's review tool, run on the owner's own computer
//                               (docs/STAGING.md §7.1) — self-contained: plain Node, no packages
import { build } from 'esbuild';

await build({
  entryPoints: {
    main: 'src/main.ts',
    migrate: 'src/db/migrate-cli.ts',
    smoke: 'scripts/smoke.ts',
    'staging-suite': 'scripts/staging-suite.ts',
    'qa-seed': 'scripts/qa-seed.ts',
    'staging-otp-check': 'scripts/staging-otp-check.ts',
    'log-scan': 'scripts/log-scan.ts',
    ops: 'scripts/ops.ts',
    'db-check': 'scripts/db-check.ts',
    'review-fixture': 'scripts/review-fixture.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  external: ['pg', 'sharp', 'hono', '@hono/node-server', 'pg-native', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});

// The owner's review tool travels as ONE file: everything bundled, nothing external, no source map.
const tool = await build({
  entryPoints: { 'velvet-review': 'scripts/review.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  tsconfig: 'tsconfig.json',
  metafile: true,
  logLevel: 'info',
});
const imports = Object.values(tool.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path));
const foreign = imports.filter((p) => !p.startsWith('node:'));
if (foreign.length) throw new Error(`velvet-review.mjs must be self-contained; it imports: ${foreign.join(', ')}`);
