#!/usr/bin/env node
/**
 * Release gate for NATIVE builds (EAS runs it as the `eas-build-post-install`
 * hook, before compiling). The web bundle is gated by check-release-bundle.mjs;
 * native bundles are built on EAS, so the inputs are checked here instead
 * (DEC-078, DEC-086):
 *   - a staging build (APP_VARIANT=staging) must use the staging channel and an
 *     https API whose host says "staging" — it can never talk to production;
 *   - a production build can never carry the staging variant, the staging
 *     channel, a staging API or the development hooks.
 * Development and preview builds are not gated.
 */
const env = process.env;
const variant = env.APP_VARIANT ?? '';
const channel = env.EXPO_PUBLIC_RELEASE_CHANNEL ?? '';
const api = env.EXPO_PUBLIC_API_URL ?? '';
const problems = [];
let host = '';
try {
  host = new URL(api).hostname;
} catch {
  /* checked below */
}

if (variant === 'staging' || channel === 'staging') {
  if (variant !== 'staging') problems.push('a staging-channel build must set APP_VARIANT=staging (its own app id and name)');
  if (channel !== 'staging') problems.push('APP_VARIANT=staging needs EXPO_PUBLIC_RELEASE_CHANNEL=staging');
  if (env.EXPO_PUBLIC_APP_ENV !== 'production') problems.push('a staging build is a release build: EXPO_PUBLIC_APP_ENV=production');
  if (!api.startsWith('https://') || !/staging/i.test(host)) {
    problems.push('EXPO_PUBLIC_API_URL must be the https staging API (set it in the EAS "preview" environment)');
  }
} else if (channel === 'production') {
  if (!api.startsWith('https://') || /staging/i.test(host)) problems.push('a production build needs the https production API');
}
if ((variant === 'staging' || channel) && env.EXPO_PUBLIC_ADMISSION_DEV_HOOKS) problems.push('development hooks are never part of a release build');

if (problems.length) {
  console.error(`Build environment refused:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(channel ? `Build environment ok: ${channel} channel → ${host}` : 'Build environment: not a release build (not gated).');
