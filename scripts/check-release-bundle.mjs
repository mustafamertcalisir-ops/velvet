// Release gate: fail if a production web bundle could expose development tooling,
// the mock backend, fixtures or a fixed one-time code.
//
// Usage: node scripts/check-release-bundle.mjs [dist-prod] [--allow-local-api] [--channel staging|production]
//   --allow-local-api  accept an http://127.0.0.1 / localhost API URL (local E2E builds only).
//   --channel          the release channel the build must be (DEC-078): a staging build must say so and
//                      talk to a staging API; a production build must not carry the staging channel or a staging API.
//
// Background: Metro can reuse cached transforms with previously inlined
// EXPO_PUBLIC_* values unless builds run with --clear (found in Phase 1 refinement).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const allowLocalApi = args.includes('--allow-local-api');
const ci = args.indexOf('--channel');
const expectedChannel = ci >= 0 ? args[ci + 1] : null;
const dir = join(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--channel') ?? 'dist-prod', '_expo/static/js/web');
const bundle = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const problems = [];

// 1. Build flags.
if (!/appEnv:"production"/.test(bundle)) problems.push('EXPO_PUBLIC_APP_ENV is not "production" in the bundle');
if (/hooksFlag:"1"/.test(bundle)) problems.push('EXPO_PUBLIC_ADMISSION_DEV_HOOKS=1 is inlined');
if (/panelFlag:"1"/.test(bundle)) problems.push('EXPO_PUBLIC_ADMISSION_DEV_PANEL=1 is inlined');

// 2. The production API (DEC-059): an inlined https URL — or a loopback URL for local E2E builds only.
const api = /apiUrl:"([^"]*)"/.exec(bundle)?.[1];
if (!api) problems.push('EXPO_PUBLIC_API_URL is not inlined: a release build must talk to the production API');
else if (!api.startsWith('https://') && !(allowLocalApi && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api))) {
  problems.push(`EXPO_PUBLIC_API_URL must be https in a release build (got ${api})`);
}

// 2b. The release channel (DEC-078): staging and production never mix.
const channel = /channel:"(staging|production)"/.exec(bundle)?.[1] ?? 'production';
if (expectedChannel && channel !== expectedChannel) problems.push(`release channel is "${channel}", expected "${expectedChannel}"`);
if (channel === 'staging' && api && !allowLocalApi && !/staging/i.test(new URL(api).hostname)) problems.push(`a staging build must talk to a staging API host (got ${api})`);
if (channel === 'production' && api && /staging/i.test(api)) problems.push(`a production build points at a staging API (${api})`);

// 3. No mock backend, no fixed OTP, no fixtures — not merely unreachable: absent (DEC-041, DEC-057, DEC-061).
const MARKERS = [
  // reviewer / billing / failure-injection fixtures
  'dev-fixture', 'confirmFixturePayment', 'loseNextResponse', '__velvetDev=', 'development_fixture',
  // member community fixture
  'velvet-community-fixture', 'seedCommunity', 'memberSays', 'usr_fx_', 'tobacco warehouse in Tophane', '__qa/',
  // the mock server itself and its fixed development code
  '246810', 'velvet.mockServer.v1', 'Development controls are not available', 'plan_membership_monthly_dev',
  // QA photography hosts
  'qa.invalid',
];
for (const marker of MARKERS) {
  if (bundle.includes(marker)) problems.push(`development or mock code present in bundle: ${marker}`);
}
// 4. The HTTP adapters must be present (the app has a backend at all).
if (!bundle.includes('/introductions/') || !bundle.includes('Idempotency-Key')) problems.push('HTTP adapters for the production API are missing');

if (problems.length) {
  console.error('Release bundle check FAILED:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(
  `Release bundle check passed: production env, ${channel} channel, API ${api}, no dev flags, no mock backend, no fixed OTP, no reviewer/billing/community fixtures.`,
);
