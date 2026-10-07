/**
 * The reviewer side of a REAL-SIM staging journey (docs/STAGING.md §8.4,
 * DEC-083), run from CI (staging-checks → review-fixture) so the runner key
 * never leaves the GitHub Environment. The applicant side happens on the
 * phone, in the staging app, with real SMS and real uploads.
 *
 *   STAGING_* (scripts/lib/staging.ts) + STAGING_REAL_PHONE (a project SIM listed in the
 *   server's SMS_QA_REAL_NUMBERS) node dist/review-fixture.mjs <STATUS | START_REVIEW |
 *   REQUEST_EXTENDED | REQUEST_IDENTITY | APPROVE | WAITLIST | NOT_ADMIT | ACTIVATE>
 *
 * Prints the status before and after and the request id of the transition
 * (for the report); the phone number is printed masked. QA accounts only:
 * the server refuses anything else.
 */
import { maskPhone, stagingClient, stagingEnv } from './lib/staging';

async function main() {
  const action = process.argv[2] ?? 'STATUS';
  const phone = process.env.STAGING_REAL_PHONE ?? '';
  if (!/^\+\d{8,15}$/.test(phone)) throw new Error('STAGING_REAL_PHONE (the project SIM, a GitHub Environment secret) is required.');
  const c = stagingClient(stagingEnv());
  await c.preflight();
  const found = await c.internal('/internal/test/applications/lookup', { phoneE164: phone });
  if (found.status !== 200) throw new Error(`No active QA account for ${maskPhone(phone)} (is it listed in SMS_QA_REAL_NUMBERS, and signed in once on the phone?)`);
  console.log(`${maskPhone(phone)}: ${found.body.status ?? 'no application yet'}  (request ${found.headers.get('x-request-id')})`);
  if (action === 'STATUS') return;
  if (!found.body.applicationId) throw new Error('No application yet: submit Stage 1 in the app first.');
  const r = await c.fixture(found.body.applicationId, action);
  if (r.status !== 200) {
    console.log(`✗ ${action}: ${r.status} ${r.body?.error?.code ?? ''}  (request ${r.headers.get('x-request-id')})`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${action}: ${found.body.status} → ${r.body.status}  (request ${r.headers.get('x-request-id')})`);
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
