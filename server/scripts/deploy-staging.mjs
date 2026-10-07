/**
 * Deploy the current commit to STAGING on Render and wait until it is live
 * (docs/STAGING.md §3, CI: .github/workflows/staging.yml).
 *
 *   RENDER_DEPLOY_HOOK_URL   the staging service's deploy hook (a secret)
 *   RENDER_API_KEY           optional: a Render API key to follow the deploy to "live"
 *   RENDER_SERVICE_ID        with RENDER_API_KEY: the staging service id (srv-…)
 *   STAGING_API_URL          https://api-staging.<domain> (readiness)
 *   GITHUB_SHA               the commit to deploy (ref=)
 *
 * Render runs the release step itself: `node dist/migrate.mjs` as the
 * service's pre-deploy command, BEFORE the new version takes traffic; a
 * failed migration fails the deploy and the previous version keeps serving.
 * Traffic moves only to instances whose /health/ready answers 200.
 *
 * Never production: refuses an API URL without "staging" in its host, and the
 * production service has no deploy hook in this repository's CI.
 * The hook URL is never printed (it carries its key).
 */
const env = process.env;
const hook = env.RENDER_DEPLOY_HOOK_URL ?? '';
const api = (env.STAGING_API_URL ?? '').replace(/\/+$/, '');
if (!hook.startsWith('https://')) throw new Error('RENDER_DEPLOY_HOOK_URL is required (GitHub environment "staging").');
if (!/^https:\/\/[^/]*staging[^/]*$/i.test(api)) throw new Error('Refusing: STAGING_API_URL must be the https staging API (its host must say "staging").');

const url = new URL(hook);
if (env.GITHUB_SHA) url.searchParams.set('ref', env.GITHUB_SHA);
const res = await fetch(url, { method: 'POST' });
if (res.status !== 200 && res.status !== 202) throw new Error(`Deploy hook answered ${res.status}`);
const body = await res.json().catch(() => ({}));
const deployId = body?.deploy?.id ?? body?.id ?? null;
console.log(`Deploy requested for ${env.GITHUB_SHA?.slice(0, 7) ?? 'the branch head'}${deployId ? ` (${deployId})` : res.status === 202 ? ' (queued behind another deploy)' : ''}.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + 25 * 60_000;

if (env.RENDER_API_KEY && env.RENDER_SERVICE_ID && deployId) {
  // Render API "Retrieve deploy" (https://api-docs.render.com/reference/retrieve-deploy).
  const FAILED = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated']);
  for (;;) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the deploy.');
    const r = await fetch(`https://api.render.com/v1/services/${env.RENDER_SERVICE_ID}/deploys/${deployId}`, {
      headers: { authorization: `Bearer ${env.RENDER_API_KEY}`, accept: 'application/json' },
    });
    const d = await r.json().catch(() => ({}));
    const status = d?.status ?? d?.deploy?.status ?? `http ${r.status}`;
    console.log(`deploy status: ${status}`);
    if (status === 'live') break;
    if (FAILED.has(status)) throw new Error(`Deploy ${status} — the previous version keeps serving.`);
    await sleep(15_000);
  }
} else {
  console.log('No Render API key: waiting for readiness only (cannot tell the new version from the old one).');
  await sleep(90_000);
}

// Readiness of what is serving now.
for (let ok = 0; ok < 3; ) {
  if (Date.now() > deadline) throw new Error('Timed out waiting for /health/ready.');
  const r = await fetch(`${api}/health/ready`).catch(() => null);
  ok = r?.status === 200 ? ok + 1 : 0;
  if (ok < 3) await sleep(5_000);
}
console.log('Staging is live and ready.');
