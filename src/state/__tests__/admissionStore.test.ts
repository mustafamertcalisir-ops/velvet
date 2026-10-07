import { createMockAdmissionApi, MOCK_OTP_CODE, OTP_MAX_ATTEMPTS } from '@/services/mock/mockAdmissionApi';
import { createMemoryStorage, type KeyValueStorage } from '@/services/storage';
import { createAdmissionStore, STORAGE_KEY } from '../admission/store';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const FIXED_NOW = new Date('2026-10-03T09:00:00.000Z');
const PHONE = '+905321234567';

function setup(storage: KeyValueStorage = createMemoryStorage()) {
  let clock = FIXED_NOW.getTime();
  const now = () => new Date(clock);
  const backend = createMockAdmissionApi({ storage, now });
  const store = createAdmissionStore({ api: backend.api, storage, now });
  return {
    storage,
    backend,
    store,
    a: store.actions,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

async function verified(ctx = setup()) {
  await ctx.a.hydrate();
  expect((await ctx.a.requestOtp(PHONE)).ok).toBe(true);
  expect((await ctx.a.verifyOtp(MOCK_OTP_CODE)).ok).toBe(true);
  return ctx;
}

function fillDraft(a: ReturnType<typeof setup>['a']) {
  expect(a.acknowledgeIntro().ok).toBe(true);
  expect(a.setFirstName('  Çağla ').ok).toBe(true);
  expect(a.setLastName('Öztürk').ok).toBe(true);
  expect(a.setDateOfBirth({ day: '14', month: '03', year: '1994' }).ok).toBe(true);
  expect(a.setInstagram('@cagla.ozturk').ok).toBe(true);
  expect(a.setCountry('TR').ok).toBe(true);
  expect(a.setCity({ kind: 'listed', cityId: 'TR-istanbul', label: 'İstanbul', region: null }).ok).toBe(true);
  expect(a.setReferral({ kind: 'none' }).ok).toBe(true);
}

describe('phone verification', () => {
  it('moves UNAUTHENTICATED → PHONE_VERIFICATION → APPLICATION_DRAFT', async () => {
    const ctx = setup();
    await ctx.a.hydrate();
    expect(ctx.store.getState().status).toBe('UNAUTHENTICATED');
    await ctx.a.requestOtp(PHONE);
    expect(ctx.store.getState().status).toBe('PHONE_VERIFICATION');
    await ctx.a.verifyOtp(MOCK_OTP_CODE);
    expect(ctx.store.getState().status).toBe('APPLICATION_DRAFT');
    expect(ctx.store.getState().session).not.toBeNull();
  });

  it('counts down attempts on a wrong code and locks after the maximum', async () => {
    const ctx = setup();
    await ctx.a.hydrate();
    await ctx.a.requestOtp(PHONE);
    const first = await ctx.a.verifyOtp('000000');
    expect(first).toEqual({ ok: false, error: { kind: 'invalid_code', attemptsRemaining: OTP_MAX_ATTEMPTS - 1 } });
    for (let i = 1; i < OTP_MAX_ATTEMPTS - 1; i++) await ctx.a.verifyOtp('000000');
    expect(await ctx.a.verifyOtp('000000')).toEqual({ ok: false, error: { kind: 'too_many_attempts' } });
    expect(await ctx.a.verifyOtp(MOCK_OTP_CODE)).toEqual({ ok: false, error: { kind: 'too_many_attempts' } });
    expect(ctx.store.getState().status).toBe('PHONE_VERIFICATION');
  });

  it('rate-limits resend and allows it after the cooldown', async () => {
    const ctx = setup();
    await ctx.a.hydrate();
    await ctx.a.requestOtp(PHONE);
    const tooSoon = await ctx.a.resendOtp();
    expect(tooSoon.ok).toBe(false);
    expect(!tooSoon.ok && tooSoon.error.kind).toBe('rate_limited');
    ctx.advanceClock(31_000);
    expect((await ctx.a.resendOtp()).ok).toBe(true);
  });

  it('expires codes', async () => {
    const ctx = setup();
    await ctx.a.hydrate();
    await ctx.a.requestOtp(PHONE);
    ctx.advanceClock(11 * 60_000);
    expect(await ctx.a.verifyOtp(MOCK_OTP_CODE)).toEqual({ ok: false, error: { kind: 'code_expired' } });
  });

  it('survives a restart during OTP entry', async () => {
    const ctx = setup();
    await ctx.a.hydrate();
    await ctx.a.requestOtp(PHONE);
    await ctx.store.flush();
    const restarted = createAdmissionStore({ api: ctx.backend.api, storage: ctx.storage, now: () => FIXED_NOW });
    await restarted.actions.hydrate();
    expect(restarted.getState().status).toBe('PHONE_VERIFICATION');
    expect((await restarted.actions.verifyOtp(MOCK_OTP_CODE)).ok).toBe(true);
  });

  it('lets the applicant change number from the code screen', async () => {
    const ctx = setup();
    await ctx.a.hydrate();
    await ctx.a.requestOtp(PHONE);
    expect(ctx.a.changePhoneNumber().ok).toBe(true);
    expect(ctx.store.getState()).toMatchObject({ status: 'UNAUTHENTICATED', otpChallenge: null });
  });
});

describe('draft', () => {
  it('persists draft data across restart', async () => {
    const ctx = await verified();
    ctx.a.acknowledgeIntro();
    ctx.a.setFirstName('İlkay');
    ctx.a.setLastName('Şahin');
    await ctx.store.flush();
    const restarted = createAdmissionStore({ api: ctx.backend.api, storage: ctx.storage, now: () => FIXED_NOW });
    await restarted.actions.hydrate();
    expect(restarted.getState().status).toBe('APPLICATION_DRAFT');
    expect(restarted.getState().draft).toMatchObject({ firstName: 'İlkay', lastName: 'Şahin' });
  });

  it('rejects an under-18 date of birth and does not store it', async () => {
    const ctx = await verified();
    const r = ctx.a.setDateOfBirth({ day: '04', month: '10', year: '2008' });
    expect(r).toEqual({ ok: false, error: 'under_minimum_age' });
    expect(ctx.store.getState().draft.dateOfBirth).toBeNull();
    expect(ctx.a.setDateOfBirth({ day: '03', month: '10', year: '2008' }).ok).toBe(true);
  });

  it('never overwrites a valid answer with an invalid one', async () => {
    const ctx = await verified();
    ctx.a.setFirstName('Deniz');
    expect(ctx.a.setFirstName('').ok).toBe(false);
    expect(ctx.store.getState().draft.firstName).toBe('Deniz');
  });

  it('clears the city when the country changes (no cross-country corruption)', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    ctx.a.setCountry('TR'); // same country — city kept
    expect(ctx.store.getState().draft.city?.label).toBe('İstanbul');
    ctx.a.setCountry('DE');
    expect(ctx.store.getState().draft.city).toBeNull();
    expect(ctx.a.setCity({ kind: 'listed', cityId: 'TR-izmir', label: 'İzmir', region: null }).ok).toBe(false);
  });

  it('rejects duplicate referrals and self-referral', async () => {
    const ctx = await verified();
    const r = { id: 'a', name: 'Kerem', phoneE164: '+905551112233' };
    expect(ctx.a.setReferral({ kind: 'requested', referrals: [r, { ...r, id: 'b' }] }).ok).toBe(false);
    expect(ctx.a.setReferral({ kind: 'requested', referrals: [{ ...r, phoneE164: PHONE }] }).ok).toBe(false);
    expect(ctx.a.setReferral({ kind: 'requested', referrals: [r] }).ok).toBe(true);
  });
});

describe('submission', () => {
  it('submits into APPLICATION_RECEIVED — never approval', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    const result = await ctx.a.submit();
    expect(result).toEqual({ ok: true, value: 'APPLICATION_RECEIVED' });
    const state = ctx.store.getState();
    expect(state.status).toBe('APPLICATION_RECEIVED');
    expect(state.application?.submittedAt).toBe(FIXED_NOW.toISOString());
    expect(state.membership).toBeNull();
    const db = await ctx.backend.dev.snapshot();
    expect(Object.values(db.applications).map((a) => a.status)).toEqual(['APPLICATION_RECEIVED']);
    expect(db.audit.map((e) => e.eventType)).toEqual(['PHONE_VERIFIED', 'APPLICATION_SUBMITTED']);
  });

  it('refuses to submit an incomplete draft', async () => {
    const ctx = await verified();
    ctx.a.acknowledgeIntro();
    const r = await ctx.a.submit();
    expect(r.ok).toBe(false);
    expect(ctx.store.getState().status).toBe('APPLICATION_DRAFT');
  });

  it('requires an Instagram handle (DEC-023)', async () => {
    const ctx = await verified();
    expect(ctx.a.setInstagram('')).toEqual({ ok: false, error: 'required' });
    expect(ctx.store.getState().draft.instagram).toBeNull();
  });

  it('keeps only name and place on the device once the server has the application', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    ctx.a.setReferral({ kind: 'requested', referrals: [{ id: 'r', name: 'Kerem Aksoy', phoneE164: '+905551112233' }] });
    await ctx.a.submit();
    await ctx.store.flush();
    const { draft } = ctx.store.getState();
    expect(draft).toMatchObject({ firstName: 'Çağla', lastName: 'Öztürk', countryCode: 'TR' });
    expect(draft.dateOfBirth).toBeNull();
    expect(draft.instagram).toBeNull();
    expect(draft.referral).toBeNull();
    const persisted = (ctx.storage as ReturnType<typeof createMemoryStorage>).dump()[STORAGE_KEY] ?? '';
    expect(persisted).not.toContain('1994-03-14');
    expect(persisted).not.toContain('5551112233');
    expect(persisted).not.toContain('cagla.ozturk');
    // …while the server holds the full private application.
    const db = await ctx.backend.dev.snapshot();
    const priv = Object.values(db.privateData)[0];
    expect(priv?.dateOfBirth).toBe('1994-03-14');
  });

  it('locks the draft after submission', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    await ctx.a.submit();
    expect(ctx.a.setFirstName('Changed')).toEqual({ ok: false, error: 'not_allowed' });
    expect(ctx.store.getState().draft.firstName).toBe('Çağla');
  });

  it('stays in APPLICATION_SUBMITTED on network failure and retries with the same key', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    ctx.backend.dev.failNext('submitStage1');
    const failed = await ctx.a.submit();
    expect(failed).toEqual({ ok: false, error: { kind: 'network' } });
    expect(ctx.store.getState().status).toBe('APPLICATION_SUBMITTED');
    const key = ctx.store.getState().pendingSubmission?.idempotencyKey;
    expect(key).toBeTruthy();
    const retried = await ctx.a.submit();
    expect(retried).toEqual({ ok: true, value: 'APPLICATION_RECEIVED' });
    const db = await ctx.backend.dev.snapshot();
    expect(Object.keys(db.applications)).toHaveLength(1);
    expect(db.idempotency[key!]).toBeDefined();
  });

  it('does not duplicate when the server received it but the response was lost', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    ctx.backend.dev.loseNextResponse('submitStage1');
    expect((await ctx.a.submit()).ok).toBe(false);
    expect((await ctx.a.submit()).ok).toBe(true);
    const db = await ctx.backend.dev.snapshot();
    expect(Object.keys(db.applications)).toHaveLength(1);
    expect(Object.keys(db.privateData)).toHaveLength(1);
  });

  it('collapses concurrent submit taps into one request', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    const [a, b, c] = await Promise.all([ctx.a.submit(), ctx.a.submit(), ctx.a.submit()]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    const db = await ctx.backend.dev.snapshot();
    expect(Object.keys(db.applications)).toHaveLength(1);
  });

  it('resumes a pending submission after restart', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    ctx.backend.dev.failNext('submitStage1');
    await ctx.a.submit();
    await ctx.store.flush();
    const restarted = createAdmissionStore({ api: ctx.backend.api, storage: ctx.storage, now: () => FIXED_NOW });
    await restarted.actions.hydrate();
    expect(restarted.getState().status).toBe('APPLICATION_SUBMITTED');
    expect(await restarted.actions.submit()).toEqual({ ok: true, value: 'APPLICATION_RECEIVED' });
  });

  it('can return to the draft after a failed submit', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    ctx.backend.dev.failNext('submitStage1');
    await ctx.a.submit();
    expect(ctx.a.returnToDraft().ok).toBe(true);
    expect(ctx.store.getState().status).toBe('APPLICATION_DRAFT');
    expect(ctx.a.setFirstName('Çağla Su').ok).toBe(true);
  });
});

describe('status after submission', () => {
  it('survives restart in APPLICATION_RECEIVED', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    await ctx.a.submit();
    await ctx.store.flush();
    const restarted = createAdmissionStore({ api: ctx.backend.api, storage: ctx.storage, now: () => FIXED_NOW });
    await restarted.actions.hydrate();
    expect(restarted.getState().status).toBe('APPLICATION_RECEIVED');
  });

  it('adopts reviewer changes from the server on refresh', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    await ctx.a.submit();
    await ctx.backend.dev.advance(ctx.store.getState().session!.userId, 'UNDER_REVIEW');
    expect(await ctx.a.refresh()).toEqual({ ok: true, value: 'UNDER_REVIEW' });
  });

  it('restores status from the server after sign-out and sign-in', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    await ctx.a.submit();
    await ctx.a.signOut();
    expect(ctx.store.getState().status).toBe('UNAUTHENTICATED');
    expect(await ctx.storage.getItem(STORAGE_KEY)).toBeNull();
    ctx.advanceClock(31_000);
    await ctx.a.requestOtp(PHONE);
    await ctx.a.verifyOtp(MOCK_OTP_CODE);
    expect(ctx.store.getState().status).toBe('APPLICATION_RECEIVED');
  });

  it('sign-out removes private draft data from the device', async () => {
    const ctx = await verified();
    fillDraft(ctx.a);
    await ctx.a.signOut();
    expect(JSON.stringify((ctx.storage as ReturnType<typeof createMemoryStorage>).dump()[STORAGE_KEY] ?? '')).not.toContain('Öztürk');
    expect(ctx.store.getState().draft.lastName).toBeNull();
  });
});
