import { canAccessMemberProduct } from '@/domain/admission/access';
import { createMockAdmissionApi, MOCK_OTP_CODE } from '@/services/mock/mockAdmissionApi';
import { createMemoryStorage } from '@/services/storage';
import { createAdmissionStore, STORAGE_KEY } from '../admission/store';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const NOW = new Date('2026-10-03T09:00:00.000Z');
const PHONE = '+905321234567';
const DATA_URI = 'data:image/jpeg;base64,' + 'A'.repeat(64);

async function underReview() {
  const storage = createMemoryStorage();
  const backend = createMockAdmissionApi({ storage, now: () => NOW });
  const store = createAdmissionStore({ api: backend.api, storage, now: () => NOW });
  const a = store.actions;
  await a.hydrate();
  await a.requestOtp(PHONE);
  await a.verifyOtp(MOCK_OTP_CODE);
  a.acknowledgeIntro();
  a.setFirstName('Gökçe');
  a.setLastName('Yıldırım');
  a.setDateOfBirth({ day: '14', month: '03', year: '1994' });
  a.setInstagram('gokce.y');
  a.setCountry('TR');
  a.setCity({ kind: 'listed', cityId: 'TR-mugla', label: 'Muğla', region: null });
  a.setReferral({ kind: 'none' });
  await a.submit();
  const userId = store.getState().session!.userId;
  await backend.dev.advance(userId, 'UNDER_REVIEW');
  await a.refresh();
  return { storage, backend, store, a, userId };
}

async function extendedDraft() {
  const ctx = await underReview();
  await ctx.backend.dev.advance(ctx.userId, 'EXTENDED_APPLICATION_REQUIRED');
  await ctx.a.refresh();
  expect((await ctx.a.beginExtendedApplication()).ok).toBe(true);
  return ctx;
}

async function fill(ctx: Awaited<ReturnType<typeof extendedDraft>>) {
  const { a } = ctx;
  expect(a.acknowledgeExtendedIntro().ok).toBe(true);
  for (let i = 0; i < 3; i++) {
    expect((await a.addPhoto({ uri: `file:///p${i}.jpg`, dataUri: DATA_URI, width: 720, height: 960 })).ok).toBe(true);
  }
  expect(a.setOccupation('Mimar').ok).toBe(true);
  expect(a.setWorkContext({ kind: 'independent' }).ok).toBe(true);
  expect(a.setWhatYouDo('Restoring wooden yalı houses on the Asian shore with a small team.').ok).toBe(true);
  expect(a.setAboutYou('I swim in the Bosphorus every morning from May until the water turns.').ok).toBe(true);
  expect(a.setInterests(['Architecture', 'Swimming', 'Jazz']).ok).toBe(true);
  expect(a.setIntents(['friendship', 'community']).ok).toBe(true);
  expect(a.markPreviewSeen().ok).toBe(true);
}

describe('extended application lifecycle', () => {
  it('cannot begin before the team requests it', async () => {
    const ctx = await underReview();
    expect(await ctx.a.beginExtendedApplication()).toEqual({ ok: false, error: { kind: 'not_allowed' } });
    expect(ctx.a.setOccupation('Mimar')).toEqual({ ok: false, error: 'not_allowed' });
  });

  it('UNDER_REVIEW → EXTENDED_APPLICATION_REQUIRED → EXTENDED_APPLICATION_DRAFT', async () => {
    const ctx = await extendedDraft();
    expect(ctx.store.getState().status).toBe('EXTENDED_APPLICATION_DRAFT');
    expect(ctx.store.getState().application?.extendedRequestedAt).not.toBeNull();
  });

  it('gets age and city from the server — the device never needs the DOB again', async () => {
    const ctx = await extendedDraft();
    expect(ctx.store.getState().summary).toEqual({ firstName: 'Gökçe', age: 32, cityLabel: 'Muğla' });
    expect(ctx.store.getState().draft.dateOfBirth).toBeNull();
  });

  it('manages photos: add, cap at six, reorder, remove', async () => {
    const ctx = await extendedDraft();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await ctx.a.addPhoto({ uri: `file:///p${i}.jpg`, dataUri: DATA_URI, width: 720, height: 960 });
      if (r.ok) ids.push(r.value.id);
    }
    expect(ids).toHaveLength(6);
    expect((await ctx.a.addPhoto({ uri: 'file:///x.jpg', dataUri: DATA_URI, width: 1, height: 1 })).ok).toBe(false);
    ctx.a.movePhoto(ids[5]!, 0);
    expect(ctx.store.getState().extendedDraft.photos[0]?.id).toBe(ids[5]);
    ctx.a.removePhoto(ids[0]!);
    expect(ctx.store.getState().extendedDraft.photos).toHaveLength(5);
    expect(ctx.store.getState().extendedDraft.photos.every((p) => p.moderationStatus === 'pending')).toBe(true);
  });

  it('reports an upload failure without adding a photo, and succeeds on retry', async () => {
    const ctx = await extendedDraft();
    ctx.backend.dev.failNext('uploadApplicationPhoto');
    const photo = { uri: 'file:///p.jpg', dataUri: DATA_URI, width: 720, height: 960 };
    expect(await ctx.a.addPhoto(photo)).toEqual({ ok: false, error: { kind: 'network' } });
    expect(ctx.store.getState().extendedDraft.photos).toHaveLength(0);
    expect((await ctx.a.addPhoto(photo)).ok).toBe(true);
  });

  it('restores the extended draft after restart', async () => {
    const ctx = await extendedDraft();
    await fill(ctx);
    await ctx.store.flush();
    const restarted = createAdmissionStore({ api: ctx.backend.api, storage: ctx.storage, now: () => NOW });
    await restarted.actions.hydrate();
    expect(restarted.getState().status).toBe('EXTENDED_APPLICATION_DRAFT');
    expect(restarted.getState().extendedDraft.photos).toHaveLength(3);
    expect(restarted.getState().extendedDraft.occupation).toBe('Mimar');
  });

  it('submits into FINAL_REVIEW — never approval, never membership', async () => {
    const ctx = await extendedDraft();
    await fill(ctx);
    expect(await ctx.a.submitExtended()).toEqual({ ok: true, value: 'FINAL_REVIEW' });
    const s = ctx.store.getState();
    expect(s.status).toBe('FINAL_REVIEW');
    expect(s.membership).toBeNull();
    expect(canAccessMemberProduct(s.status, s.membership)).toBe(false);
    const db = await ctx.backend.dev.snapshot();
    const app = Object.values(db.applications)[0]!;
    expect(app.status).toBe('FINAL_REVIEW');
    expect(app.decisionAt).toBeNull();
    expect(Object.keys(db.memberships)).toHaveLength(0);
    expect(db.audit.map((e) => e.eventType)).toContain('EXTENDED_APPLICATION_SUBMITTED');
  });

  it('stays in EXTENDED_APPLICATION_SUBMITTED on network failure and retries once only', async () => {
    const ctx = await extendedDraft();
    await fill(ctx);
    ctx.backend.dev.loseNextResponse('submitStage2');
    expect((await ctx.a.submitExtended()).ok).toBe(false);
    expect(ctx.store.getState().status).toBe('EXTENDED_APPLICATION_SUBMITTED');
    expect(ctx.a.setOccupation('Changed')).toEqual({ ok: false, error: 'not_allowed' });
    expect(await ctx.a.submitExtended()).toEqual({ ok: true, value: 'FINAL_REVIEW' });
    const db = await ctx.backend.dev.snapshot();
    expect(db.audit.filter((e) => e.eventType === 'EXTENDED_APPLICATION_SUBMITTED')).toHaveLength(1);
  });

  it('refuses an incomplete extended application', async () => {
    const ctx = await extendedDraft();
    ctx.a.acknowledgeExtendedIntro();
    const r = await ctx.a.submitExtended();
    expect(r.ok).toBe(false);
    expect(ctx.store.getState().status).toBe('EXTENDED_APPLICATION_DRAFT');
  });

  it('clears the extended answers from the device once the server has them', async () => {
    const ctx = await extendedDraft();
    await fill(ctx);
    await ctx.a.submitExtended();
    await ctx.store.flush();
    expect(ctx.store.getState().extendedDraft.photos).toHaveLength(0);
    const persisted = ctx.storage.dump()[STORAGE_KEY] ?? '';
    expect(persisted).not.toContain('Bosphorus every morning');
    const db = await ctx.backend.dev.snapshot();
    expect(Object.values(db.privateData)[0]?.personalResponse).toContain('Bosphorus every morning');
  });
});
