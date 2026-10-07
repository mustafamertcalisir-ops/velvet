/**
 * App configuration.
 *
 * BRAND: the product name is NOT finalised (DECISIONS.md DEC-028). The
 * working name lives here only, is used for the wordmark alone, and must not
 * be woven into copy, identifiers or assets.
 */
export const BRAND = {
  workingName: 'Velvet',
} as const;

/**
 * Which backend the app talks to (DEC-059):
 *   mock  in-app mock server — local development and deterministic E2E only;
 *   http  the production API at EXPO_PUBLIC_API_URL.
 * Release builds (EXPO_PUBLIC_APP_ENV=production) are ALWAYS http: the mock
 * is not even bundled (src/services/index.ts, scripts/check-release-bundle.mjs).
 */
export type BackendKind = 'mock' | 'http';

export function resolveBackend(input: { appEnv: string | undefined; backend: string | undefined; apiUrl: string | undefined }): {
  kind: BackendKind;
  apiUrl: string;
} {
  const apiUrl = (input.apiUrl ?? '').trim();
  if (input.appEnv === 'production') return { kind: 'http', apiUrl };
  return input.backend === 'http' ? { kind: 'http', apiUrl } : { kind: 'mock', apiUrl };
}

export const BACKEND = resolveBackend({
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
  backend: process.env.EXPO_PUBLIC_BACKEND,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
});

/**
 * Which release this build is (DEC-078). Release builds are all
 * EXPO_PUBLIC_APP_ENV=production (http backend, no dev tooling); the channel
 * says whether it talks to STAGING or PRODUCTION:
 *   staging     internal-distribution builds against the staging API — a separate
 *               app id (app.config.ts, APP_VARIANT=staging) and a quiet "Staging"
 *               mark on the launch screen and in You; never a banner
 *   production  store builds
 *   development everything else (mock backend, dev builds)
 * The app has no analytics SDK, so there is no analytics stream to separate.
 */
export type ReleaseChannel = 'development' | 'staging' | 'production';

export function resolveReleaseChannel(input: { appEnv: string | undefined; channel: string | undefined }): ReleaseChannel {
  if (input.appEnv !== 'production') return 'development';
  return input.channel === 'staging' ? 'staging' : 'production';
}

export const RELEASE_CHANNEL: ReleaseChannel = resolveReleaseChannel({
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
  channel: process.env.EXPO_PUBLIC_RELEASE_CHANNEL,
});

/** Simulated network latency for the mock backend. */
export const MOCK_LATENCY_MS = 650;

// ---------------------------------------------------------------------------
// Development tooling — two separate, explicit flags.
//
//  hooks  `globalThis.__velvetDev` (fail next request, simulate a reviewer).
//         No UI. Used by automated tests. On in dev builds, or with
//         EXPO_PUBLIC_ADMISSION_DEV_HOOKS=1.
//  panel  Visible dev UI: the OTP hint and the "simulate review" controls.
//         Off unless EXPO_PUBLIC_ADMISSION_DEV_PANEL=1 is set explicitly —
//         even in dev builds — so it never appears in normal screenshots.
//
// EXPO_PUBLIC_APP_ENV=production forces BOTH off regardless of other flags.
// Release builds must set it (see eas.json); e2e/run.mjs verifies a
// production-mode bundle renders no dev UI and exposes no hooks.
// ---------------------------------------------------------------------------

export type DevFlags = { hooks: boolean; panel: boolean };

export function resolveDevFlags(input: {
  isDev: boolean;
  appEnv: string | undefined;
  hooksFlag: string | undefined;
  panelFlag: string | undefined;
}): DevFlags {
  if (input.appEnv === 'production') return { hooks: false, panel: false };
  const hooks = input.isDev || input.hooksFlag === '1';
  const panel = hooks && input.panelFlag === '1';
  return { hooks, panel };
}

export const DEV_FLAGS: DevFlags = resolveDevFlags({
  isDev: typeof __DEV__ !== 'undefined' && __DEV__,
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
  hooksFlag: process.env.EXPO_PUBLIC_ADMISSION_DEV_HOOKS,
  panelFlag: process.env.EXPO_PUBLIC_ADMISSION_DEV_PANEL,
});
