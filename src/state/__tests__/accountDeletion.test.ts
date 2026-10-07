/**
 * Account deletion and sign-out from the app (DEC-077): the server is told,
 * every session ends, the member leaves the community, this device is cleared
 * — and a failed request changes nothing.
 */
import { createMockAdmissionApi, MOCK_OTP_CODE } from '@/services/mock/mockAdmissionApi';
import { createMemoryStorage } from '@/services/storage';
import type { AdmissionApi } from '@/services/api/types';
import { createAdmissionStore } from '../admission/store';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const now = () => new Date('2026-10-05T09:00:00.000Z');

async function signedIn(api?: (base: AdmissionApi) => AdmissionApi) {
  const serverStorage = createMemoryStorage();
  const backend = createMockAdmissionApi({ storage: serverStorage, now });
  const device = createMemoryStorage();
  const store = createAdmissionStore({ api: api ? api(backend.api) : backend.api, storage: device, now });
  await store.actions.hydrate();
  await store.actions.requestOtp('+905321234567');
  await store.actions.verifyOtp(MOCK_OTP_CODE);
  return { store, backend, device, session: store.getState().session! };
}

describe('account deletion', () => {
  it('deletes on the server, revokes every session, clears this device and leaves a one-time notice', async () => {
    const { store, backend, device, session } = await signedIn();
    // A second device of the same person.
    const other = createAdmissionStore({ api: backend.api, storage: createMemoryStorage(), now });
    await other.actions.hydrate();
    expect((await backend.api.getMyApplication(session)).ok).toBe(true);

    const r = await store.actions.deleteAccount();
    expect(r).toEqual({ ok: true, value: undefined });
    expect(store.getState().status).toBe('UNAUTHENTICATED');
    expect(store.getState().session).toBeNull();
    expect(store.getState().signedOutBecause).toBe('account_deleted');
    expect(await device.getItem('velvet.admission.v1')).toBeNull();
    // The old session is refused by the server.
    expect(await backend.api.getMyApplication(session)).toEqual({ ok: false, error: { kind: 'unauthorized' } });
    store.actions.dismissSignedOutNotice();
    expect(store.getState().signedOutBecause).toBeNull();
  });

  it('a deleted account cannot sign in again with the same number', async () => {
    const { store } = await signedIn();
    await store.actions.deleteAccount();
    await store.actions.requestOtp('+905321234567');
    const v = await store.actions.verifyOtp(MOCK_OTP_CODE);
    expect(v.ok).toBe(false);
    expect(store.getState().session).toBeNull();
  });

  it('when the request fails, nothing changes: still signed in, can retry', async () => {
    let failing = true;
    const { store, session } = await signedIn((base) => ({
      ...base,
      requestAccountDeletion: (s) => (failing ? Promise.resolve({ ok: false, error: { kind: 'network' } }) : base.requestAccountDeletion(s)),
    }));
    const r = await store.actions.deleteAccount();
    expect(r).toEqual({ ok: false, error: { kind: 'network' } });
    expect(store.getState().session).toEqual(session);
    expect(store.getState().signedOutBecause ?? null).toBeNull();
    failing = false;
    expect((await store.actions.deleteAccount()).ok).toBe(true);
  });
});

describe('responses that arrive after the device was cleared', () => {
  it('are never adopted: a refresh in flight during the deletion writes nothing back, and the notice survives a late 401', async () => {
    let releaseRefresh: () => void = () => undefined;
    const { store, device } = await signedIn((base) => ({
      ...base,
      // A refresh that the server answered before the deletion, but that arrives after it.
      getMyApplication: async (s) => {
        const answer = await base.getMyApplication(s);
        await new Promise<void>((r) => (releaseRefresh = r));
        return answer;
      },
    }));
    const refresh = store.actions.refresh();
    await new Promise((r) => setTimeout(r, 0));
    expect((await store.actions.deleteAccount()).ok).toBe(true);
    releaseRefresh();
    await refresh;
    await store.flush();
    expect(store.getState().session).toBeNull();
    expect(store.getState().status).toBe('UNAUTHENTICATED');
    expect(store.getState().application).toBeNull();
    expect(store.getState().signedOutBecause).toBe('account_deleted');
    expect(await device.getItem('velvet.admission.v1')).toBeNull();
    // A late 401 from somewhere else (e.g. the member store) signs out again without wiping the notice.
    await store.actions.signOut();
    expect(store.getState().signedOutBecause).toBe('account_deleted');
  });
});

describe('sign out', () => {
  it('revokes the session on the server, then clears the device', async () => {
    const { store, backend, session } = await signedIn();
    await store.actions.signOut();
    expect(store.getState().session).toBeNull();
    expect(store.getState().signedOutBecause ?? null).toBeNull();
    expect(await backend.api.getMyApplication(session)).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });

  it('never waits on a dead network: the device is cleared even if the server cannot be reached', async () => {
    const { store } = await signedIn((base) => ({ ...base, signOut: () => new Promise(() => undefined) }));
    jest.useFakeTimers();
    const done = store.actions.signOut();
    await jest.advanceTimersByTimeAsync(3100);
    await done;
    jest.useRealTimers();
    expect(store.getState().session).toBeNull();
  });
});
