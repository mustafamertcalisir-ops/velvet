/**
 * Backend selection (DEC-059). Screens and stores depend only on the ports
 * (AdmissionApi, MemberApi); this module decides which implementation runs.
 *
 *   release builds        → HTTP adapters to the production API, always.
 *   EXPO_PUBLIC_BACKEND=http → HTTP adapters (local server, staging).
 *   otherwise             → the in-app mock server (development, deterministic E2E).
 *
 * The mock is loaded with a conditional `require` whose condition is a
 * build-time constant: in a release build it folds to `null` before Metro
 * collects dependencies, so the mock server, its fixed development OTP and
 * every fixture are absent from the bundle (scripts/check-release-bundle.mjs).
 */
import { BACKEND, DEV_FLAGS, MOCK_LATENCY_MS } from '@/config';
import type { MemberApi } from './api/memberTypes';
import type { AdmissionApi } from './api/types';
import { developmentFixtureBilling, unavailableBilling, type BillingProvider } from './billing/billing';
import { createHttpAdmissionApi } from './http/httpAdmissionApi';
import { createHttpClient } from './http/httpClient';
import { createHttpMemberApi } from './http/httpMemberApi';
import type { MockAdmissionBackend } from './mock/mockAdmissionApi';
import { deviceStorage } from './storage';

export type Backend = {
  kind: 'mock' | 'http';
  api: AdmissionApi;
  member: MemberApi;
  /** Development controls — the mock only; never present in release builds. */
  dev: MockAdmissionBackend['dev'] | null;
};

type MockModule = typeof import('./mock/mockAdmissionApi');

/** Build-time constant condition: `null` in release builds and when the HTTP backend is chosen. */
function loadMock(): MockModule | null {
  return process.env.EXPO_PUBLIC_APP_ENV === 'production'
    ? null
    : process.env.EXPO_PUBLIC_BACKEND === 'http'
      ? null
      : // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('./mock/mockAdmissionApi') as MockModule);
}

let backend: Backend | null = null;

export function getBackend(): Backend {
  if (backend) return backend;
  const mock = BACKEND.kind === 'mock' ? loadMock() : null;
  if (mock) {
    const m = mock.createMockAdmissionApi({ storage: deviceStorage, latencyMs: MOCK_LATENCY_MS });
    backend = { kind: 'mock', api: m.api, member: m.member, dev: m.dev };
    if (process.env.EXPO_PUBLIC_APP_ENV !== 'production' && DEV_FLAGS.hooks) {
      // Development fixtures and end-to-end tests only. Never in production (src/config.ts).
      (globalThis as { __velvetDev?: MockAdmissionBackend['dev'] }).__velvetDev = m.dev;
    }
  } else {
    const call = createHttpClient({ baseUrl: BACKEND.apiUrl });
    backend = { kind: 'http', api: createHttpAdmissionApi(call), member: createHttpMemberApi(call), dev: null };
  }
  return backend;
}

/**
 * Release builds have no billing provider yet, so membership activation is
 * shown as not yet open. Development builds on the mock use the fixture
 * provider; on the HTTP backend, activation is confirmed server-side
 * (the provider's confirmation reaches the API, never the app).
 */
export function getBilling(): BillingProvider {
  if (process.env.EXPO_PUBLIC_APP_ENV === 'production' || !DEV_FLAGS.hooks) return unavailableBilling;
  const dev = getBackend().dev;
  return dev ? developmentFixtureBilling((userId) => dev.confirmFixturePayment(userId)) : unavailableBilling;
}

/** The mock's fixed development code, for the opt-in development panel only. Null everywhere else. */
export function developmentOtpHint(): string | null {
  if (process.env.EXPO_PUBLIC_APP_ENV === 'production') return null;
  return getBackend().kind === 'mock' ? (loadMock()?.MOCK_OTP_CODE ?? null) : null;
}
