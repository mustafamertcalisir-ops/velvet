/**
 * Scheduled operations (docs/STAGING.md §4): one signed internal call per run,
 * so a platform cron job needs no database access and no extra credentials.
 *
 *   node dist/ops.mjs retention [--dry-run]     POST /internal/retention/run      (scope retention:run)
 *   node dist/ops.mjs reconcile [--repair]      POST /internal/media/reconcile    (scope media:reconcile; dry run unless --repair)
 *
 *   OPS_ENVIRONMENT   staging | production (the signature is bound to it); default APP_ENV
 *   OPS_API_URL       https://… the API; default PUBLIC_BASE_URL
 *   OPS_KEY_ID / OPS_KEY_SECRET   an internal key with the scope above; defaults `ops` and
 *                     INTERNAL_KEY_OPS_SECRET (DEC-081: the platform-generated secret, shared by the
 *                     API and the cron through an environment group — so the same command also runs
 *                     as a one-off job on the API service itself)
 *
 * Prints the structured report (counts and opaque ids only) and exits 1 on failure.
 */
import { signInternalRequest } from '../src/http/internalAuth';

async function main() {
  const env = process.env;
  const [command, flag] = process.argv.slice(2);
  const target = env.OPS_ENVIRONMENT || env.APP_ENV || '';
  if (target !== 'staging' && target !== 'production') throw new Error('OPS_ENVIRONMENT must be staging or production.');
  const api = (env.OPS_API_URL || env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!api.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api)) throw new Error('OPS_API_URL must be https.');
  const keyId = env.OPS_KEY_ID || 'ops';
  const keySecret = env.OPS_KEY_SECRET || env.INTERNAL_KEY_OPS_SECRET || '';
  if (!keySecret) throw new Error('OPS_KEY_SECRET (or INTERNAL_KEY_OPS_SECRET) is required.');
  const calls: Record<string, { path: string; body: unknown }> = {
    retention: { path: '/internal/retention/run', body: { dryRun: flag === '--dry-run' } },
    reconcile: { path: '/internal/media/reconcile', body: { mode: flag === '--repair' ? 'repair' : 'dry-run' } },
  };
  const call = calls[command ?? ''];
  if (!call) throw new Error('Usage: ops retention [--dry-run] | ops reconcile [--repair]');
  const raw = JSON.stringify(call.body);
  const headers = signInternalRequest({ env: target, keyId, secret: keySecret, method: 'POST', pathAndQuery: call.path, body: raw });
  const res = await fetch(`${api}${call.path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: raw });
  const body = await res.json().catch(() => null);
  console.log(JSON.stringify({ command, status: res.status, report: body }));
  if (res.status !== 200) process.exitCode = 1;
}

void main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
