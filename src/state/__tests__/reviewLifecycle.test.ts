/**
 * Review outcomes end to end against the mock server: reviewer actions, audit,
 * MORE_INFORMATION_REQUIRED, waitlist, approval → membership activation,
 * not admitted — and dating preferences privacy.
 */
import { canAccessMemberProduct } from '@/domain/admission/access';
import { buildProfilePreview } from '@/domain/profile/profilePresentation';
import { homeRoute } from '@/navigation/routes';
import { developmentFixtureBilling } from '@/services/billing/billing';
import { createMockAdmissionApi, MOCK_OTP_CODE } from '@/services/mock/mockAdmissionApi';
import { createMemoryStorage } from '@/services/storage';
import { createAdmissionStore } from '../admission/store';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const NOW = new Date('2026-10-05T09:00:00.000Z');
const PHONE = '+905321234567';
const DATA_URI = 'data:image/jpeg;base64,' + 'A'.repeat(64);
const DATA_URI_NEW = 'data:image/jpeg;base64,' + 'B'.repeat(64);

type Options = { dating?: boolean; fixtureBilling?: boolean };

async function received(opts: Options = {}) {
  const storage = createMemoryStorage();
  const backend = createMockAdmissionApi({ storage, now: () => NOW });
  const billing = opts.fixtureBilling ? developmentFixtureBilling((id) => backend.dev.confirmFixturePayment(id)) : undefined;
  const store = createAdmissionStore({ api: backend.api, storage, billing, now: () => NOW });
  const a = store.actions;
  await a.hydrate();
  await a.requestOtp(PHONE);
  await a.verifyOtp(MOCK_OTP_CODE);
  a.acknowledgeIntro();
  a.setFirstName('Şebnem');
  a.setLastName('Karaosmanoğlu-Büyükçekmeceli');
  a.setDateOfBirth({ day: '14', month: '03', year: '1994' });
  a.setInstagram('sebnem.k');
  a.setCountry('TR');
  a.setCity({ kind: 'listed', cityId: 'TR-kahramanmaras', label: 'Kahramanmaraş', region: null });
  a.setReferral({ kind: 'none' });
  await a.submit();
  const userId = store.getState().session!.userId;
  const appId = () => store.getState().application!.id;
  return { storage, backend, store, a, userId, appId, opts };
}

type Ctx = Awaited<ReturnType<typeof received>>;

async function finalReview(opts: Options = {}): Promise<Ctx> {
  const ctx = await received(opts);
  const { a, backend, userId } = ctx;
  await backend.dev.advance(userId, 'UNDER_REVIEW');
  await backend.dev.advance(userId, 'EXTENDED_APPLICATION_REQUIRED');
  await a.refresh();
  await a.beginExtendedApplication();
  a.acknowledgeExtendedIntro();
  for (let i = 0; i < 3; i++) await a.addPhoto({ uri: `file:///p${i}.jpg`, dataUri: DATA_URI, width: 720, height: 960 });
  a.setOccupation('Restoration architect');
  a.setWorkContext({ kind: 'organisation', name: 'Atölye Kuzguncuk' });
  a.setWhatYouDo('Restoring wooden yalı houses on the Asian shore with a small team.');
  a.setAboutYou('I swim in the Bosphorus every morning from May until the water turns.');
  a.setInterests(['Architecture', 'Swimming', 'Jazz']);
  if (opts.dating) {
    a.setIntents(['dating', 'community']);
    expect(a.setMeetPreference(['women']).ok).toBe(true);
    expect(a.setAgeRange({ min: 29, max: 41 }).ok).toBe(true);
  } else {
    a.setIntents(['friendship', 'community']);
  }
  a.markPreviewSeen();
  const res = await a.submitExtended();
  expect(res).toEqual({ ok: true, value: 'FINAL_REVIEW' });
  return ctx;
}

const events = async (ctx: Ctx) => (await ctx.backend.dev.snapshot()).audit;

describe('reviewer actions', () => {
  it('validates every action against the lifecycle — approval only after final review', async () => {
    const ctx = await received();
    const { reviewer } = ctx.backend;
    expect(await reviewer.apply(ctx.appId(), { kind: 'APPROVE' }, { reviewerId: 'r1' })).toEqual({ ok: false, error: 'not_allowed' });
    expect((await reviewer.apply(ctx.appId(), { kind: 'START_REVIEW' }, { reviewerId: 'r1' })).ok).toBe(true);
    expect(await reviewer.apply(ctx.appId(), { kind: 'START_REVIEW' }, { reviewerId: 'r1' })).toEqual({ ok: false, error: 'not_allowed' });
    expect(await reviewer.apply(ctx.appId(), { kind: 'APPROVE' }, { reviewerId: 'r1' })).toEqual({ ok: false, error: 'not_allowed' });
    // The development fixture has no shortcut either.
    await expect(ctx.backend.dev.advance(ctx.userId, 'APPROVED')).rejects.toThrow(/refused/);
  });

  it('writes one structured audit event per reviewer transition, with internal reason codes', async () => {
    const ctx = await finalReview();
    await ctx.backend.dev.review(ctx.userId, { kind: 'WAITLIST', reason: 'CAPACITY' });
    const audit = await events(ctx);
    const types = audit.map((e) => e.eventType);
    expect(types).toEqual([
      'PHONE_VERIFIED',
      'APPLICATION_SUBMITTED',
      'APPLICATION_REVIEW_STARTED',
      'EXTENDED_APPLICATION_REQUESTED',
      'EXTENDED_APPLICATION_STARTED',
      'EXTENDED_APPLICATION_SUBMITTED',
      'FINAL_REVIEW_STARTED',
      'APPLICATION_WAITLISTED',
    ]);
    const waitlisted = audit.at(-1)!;
    expect(waitlisted).toMatchObject({
      applicationId: ctx.appId(),
      previousStatus: 'FINAL_REVIEW',
      newStatus: 'WAITLISTED',
      actorType: 'reviewer',
      actorId: 'dev-fixture',
      reasonCode: 'CAPACITY',
    });
    expect(typeof waitlisted.createdAt).toBe('string');
    const db = await ctx.backend.dev.snapshot();
    expect(db.reviews.at(-1)).toMatchObject({ action: 'WAITLIST', reasonCode: 'CAPACITY', reviewerId: 'dev-fixture' });
  });

  it('never sends reviewer identity, reason codes or internal records to the applicant', async () => {
    const ctx = await finalReview();
    await ctx.backend.dev.review(ctx.userId, { kind: 'NOT_ADMIT', reason: 'SAFETY' });
    const mine = await ctx.backend.api.getMyApplication(ctx.store.getState().session!);
    const json = JSON.stringify(mine);
    expect(json).not.toContain('dev-fixture');
    expect(json).not.toContain('SAFETY');
    expect(json).not.toContain('reasonCode');
    expect(JSON.stringify(ctx.store.getState())).not.toContain('SAFETY');
  });

  it('refuses reopening into final review before an extended application exists', async () => {
    const ctx = await received();
    await ctx.backend.dev.advance(ctx.userId, 'UNDER_REVIEW');
    await ctx.backend.dev.advance(ctx.userId, 'WAITLISTED');
    expect(await ctx.backend.reviewer.apply(ctx.appId(), { kind: 'REOPEN', to: 'FINAL_REVIEW' }, { reviewerId: 'r' })).toEqual({
      ok: false,
      error: 'needs_extended_application',
    });
  });
});

describe('MORE_INFORMATION_REQUIRED', () => {
  it('shows the request, takes a replacement photo, and returns to final review', async () => {
    const ctx = await finalReview();
    const { a, backend, store, userId } = ctx;
    const before = await backend.dev.snapshot();
    const first = Object.values(before.media).find((m) => m.order === 0)!;
    await backend.dev.review(userId, { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: first.id }] });
    await a.refresh();

    const s = store.getState();
    expect(s.status).toBe('MORE_INFORMATION_REQUIRED');
    expect(s.application?.moreInformationReturnTo).toBe('FINAL_REVIEW');
    expect(s.informationRequests).toHaveLength(1);
    const req = s.informationRequests[0]!;
    expect(req).toMatchObject({ type: 'REPLACE_PHOTO', status: 'open', explanation: expect.stringContaining('photos') });
    expect(req.current).toEqual({ kind: 'photo', uri: DATA_URI });

    // Nothing to send until every request is answered.
    expect((await a.submitInformationUpdate()).ok).toBe(false);
    expect((await a.answerWithPhoto(req.id, { dataUri: DATA_URI_NEW, width: 720, height: 960 })).ok).toBe(true);
    expect(store.getState().informationRequests[0]!.status).toBe('answered');

    expect(await a.submitInformationUpdate()).toEqual({ ok: true, value: 'FINAL_REVIEW' });
    expect(store.getState().informationRequests).toEqual([]);
    expect(store.getState().application?.informationProvidedAt).not.toBeNull();

    const after = await backend.dev.snapshot();
    const resolved = Object.values(after.informationRequests)[0]!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).not.toBeNull();
    const profile = Object.values(after.media).filter((m) => m.order >= 0 && !m.retiredAt).sort((x, y) => x.order - y.order);
    expect(profile[0]!.storageKey).toBe(DATA_URI_NEW);
    expect(after.media[first.id]!.retiredAt).not.toBeNull();
    expect(after.audit.at(-1)).toMatchObject({
      eventType: 'MORE_INFORMATION_PROVIDED',
      previousStatus: 'MORE_INFORMATION_REQUIRED',
      newStatus: 'FINAL_REVIEW',
      actorType: 'applicant',
    });
  });

  it('identity confirmation: a VERIFICATION_MEDIA upload; the photo is never sent back, only that it was received', async () => {
    const ctx = await finalReview();
    const { a, backend, store, userId } = ctx;
    const api = backend.api;
    await backend.dev.review(userId, { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'CONFIRM_IDENTITY' }] });
    await a.refresh();
    const req = store.getState().informationRequests[0]!;
    expect(req.type).toBe('VERIFY_IDENTITY');
    // The class must match the request: an APPLICATION_MEDIA upload cannot answer it.
    const session = store.getState().session!;
    expect(await api.uploadApplicationPhoto(session, { dataUri: DATA_URI_NEW, width: 10, height: 10 }, { requestId: req.id })).toEqual({
      ok: false,
      error: { kind: 'not_allowed' },
    });
    expect((await a.answerWithPhoto(req.id, { dataUri: DATA_URI_NEW, width: 720, height: 960 })).ok).toBe(true);
    const answered = store.getState().informationRequests[0]!;
    expect(answered.status).toBe('answered');
    expect(answered.response).toEqual({ kind: 'verification_received' });
    expect(JSON.stringify(store.getState())).not.toContain(DATA_URI_NEW);
    expect(await a.submitInformationUpdate()).toEqual({ ok: true, value: 'FINAL_REVIEW' });
    // Kept privately for the team; never part of the profile.
    const media = Object.values((await backend.dev.snapshot()).media).filter((m) => m.purpose === 'verification');
    expect(media).toHaveLength(1);
    expect(media[0]!.order).toBe(-1);
  });

  it('returns to the stage that asked (under review) and keeps unrelated fields locked', async () => {
    const ctx = await received();
    const { a, backend, store, userId } = ctx;
    await backend.dev.advance(userId, 'UNDER_REVIEW');
    await backend.dev.review(userId, { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'INSTAGRAM_NOT_FOUND' }] });
    await a.refresh();
    const req = store.getState().informationRequests[0]!;
    expect(req.current).toEqual({ kind: 'instagram', handle: 'sebnem.k' });

    // Nothing else can be edited.
    expect(a.setFirstName('Zeynep')).toEqual({ ok: false, error: 'not_allowed' });
    expect(a.setOccupation('Chef')).toEqual({ ok: false, error: 'not_allowed' });
    expect((await a.answerInformationRequest(req.id, { type: 'UPDATE_APPLICATION_FIELD', field: 'aboutYou', value: 'x'.repeat(60) })).ok).toBe(false);
    const session = store.getState().session!;
    expect(await backend.api.respondToInformationRequest(session, req.id, { type: 'CLARIFY_WORK', occupation: 'Chef', workContext: { kind: 'independent' } })).toEqual({
      ok: false,
      error: { kind: 'not_allowed' },
    });
    expect(await backend.api.uploadApplicationPhoto(session, { dataUri: DATA_URI, width: 1, height: 1 })).toEqual({
      ok: false,
      error: { kind: 'not_allowed' },
    });
    expect(await backend.api.uploadApplicationPhoto(session, { dataUri: DATA_URI, width: 1, height: 1 }, { requestId: req.id })).toEqual({
      ok: false,
      error: { kind: 'not_allowed' },
    });

    // Invalid values are refused; a valid handle is saved and sent.
    expect((await a.answerInformationRequest(req.id, { type: 'UPDATE_INSTAGRAM', handle: 'not a handle!!' })).ok).toBe(false);
    expect((await a.answerInformationRequest(req.id, { type: 'UPDATE_INSTAGRAM', handle: '@Sebnem.Karaosmanoglu' })).ok).toBe(true);
    expect(await a.submitInformationUpdate()).toEqual({ ok: true, value: 'UNDER_REVIEW' });
    const db = await backend.dev.snapshot();
    const priv = Object.values(db.privateData)[0]!;
    expect(priv.instagram.handle).toBe('sebnem.karaosmanoglu');
    expect(priv.firstName).toBe('Şebnem');
  });

  it('clarifies work and written answers only through their own requests', async () => {
    const ctx = await finalReview();
    const { a, backend, store, userId } = ctx;
    await backend.dev.review(userId, {
      kind: 'REQUEST_INFORMATION',
      requests: [{ preset: 'WORK_UNCLEAR' }, { preset: 'KNOWN_FOR_MORE' }],
    });
    await a.refresh();
    const [work, text] = store.getState().informationRequests;
    expect(work!.current).toEqual({ kind: 'work', occupation: 'Restoration architect', workContext: { kind: 'organisation', name: 'Atölye Kuzguncuk' } });
    expect(text!.current).toMatchObject({ kind: 'text', field: 'whatYouDo' });
    expect(
      (await a.answerInformationRequest(work!.id, { type: 'CLARIFY_WORK', occupation: 'Conservation architect', workContext: { kind: 'independent' } })).ok,
    ).toBe(true);
    // The written-answer request may not touch a different field.
    expect((await a.answerInformationRequest(text!.id, { type: 'UPDATE_APPLICATION_FIELD', field: 'aboutYou', value: 'y'.repeat(80) })).ok).toBe(false);
    expect(
      (await a.answerInformationRequest(text!.id, { type: 'UPDATE_APPLICATION_FIELD', field: 'whatYouDo', value: 'I restore yalı houses and teach two conservation studios a year.' })).ok,
    ).toBe(true);
    expect(await a.submitInformationUpdate()).toEqual({ ok: true, value: 'FINAL_REVIEW' });
    const priv = Object.values((await backend.dev.snapshot()).privateData)[0]!;
    expect(priv.occupation).toBe('Conservation architect');
    expect(priv.workContext).toBe('Independent');
    expect(priv.personalResponse).toContain('Bosphorus'); // untouched
  });

  it('only photos actually submitted can be asked about', async () => {
    const ctx = await received();
    const { a, backend, userId } = ctx;
    await backend.dev.advance(userId, 'UNDER_REVIEW');
    await backend.dev.advance(userId, 'EXTENDED_APPLICATION_REQUIRED');
    await a.refresh();
    await a.beginExtendedApplication();
    a.acknowledgeExtendedIntro();
    for (let i = 0; i < 4; i++) await a.addPhoto({ uri: `file:///p${i}.jpg`, dataUri: DATA_URI, width: 720, height: 960 });
    const removed = ctx.store.getState().extendedDraft.photos[0]!.id;
    a.removePhoto(removed);
    a.setOccupation('Chef');
    a.setWorkContext({ kind: 'independent' });
    a.setWhatYouDo('Slow Aegean cooking from a twelve-seat counter in Kadıköy.');
    a.setAboutYou('I run a winter supper club for strangers on the Asian side.');
    a.setInterests(['Cooking', 'Wine', 'Travel']);
    a.setIntents(['community']);
    a.markPreviewSeen();
    expect((await a.submitExtended()).ok).toBe(true);
    const db = await backend.dev.snapshot();
    expect(db.media[removed]!.order).toBe(-1);
    expect(await backend.reviewer.apply(ctx.appId(), { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: removed }] }, { reviewerId: 'r' })).toEqual({
      ok: false,
      error: 'request_invalid_target',
    });
  });

  it('refuses request rounds that name nothing real', async () => {
    const ctx = await received();
    await ctx.backend.dev.advance(ctx.userId, 'UNDER_REVIEW');
    const apply = (requests: never[] | { preset: string; mediaId?: string }[]) =>
      ctx.backend.reviewer.apply(ctx.appId(), { kind: 'REQUEST_INFORMATION', requests: requests as never }, { reviewerId: 'r' });
    expect(await apply([])).toEqual({ ok: false, error: 'request_empty' });
    expect(await apply([{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: 'med_missing' }])).toEqual({ ok: false, error: 'request_invalid_target' });
    expect(await apply([{ preset: 'WORK_UNCLEAR' }])).toEqual({ ok: false, error: 'request_invalid_target' }); // no Stage 2 yet
    expect(await apply([{ preset: 'FREE_TEXT_QUESTION' }])).toEqual({ ok: false, error: 'request_unknown_preset' });
    expect(ctx.store.getState().status).toBe('APPLICATION_RECEIVED'); // device not yet refreshed; server unchanged:
    expect((await ctx.backend.dev.snapshot()).applications[ctx.userId]!.status).toBe('UNDER_REVIEW');
  });

  it('a submitted update survives a lost response (idempotent)', async () => {
    const ctx = await received();
    const { a, backend, store, userId } = ctx;
    await backend.dev.advance(userId, 'UNDER_REVIEW');
    await backend.dev.review(userId, { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'INSTAGRAM_NOT_FOUND' }] });
    await a.refresh();
    const req = store.getState().informationRequests[0]!;
    await a.answerInformationRequest(req.id, { type: 'UPDATE_INSTAGRAM', handle: 'sebnem.k2' });
    backend.dev.loseNextResponse('submitInformationUpdate');
    expect((await a.submitInformationUpdate()).ok).toBe(false);
    expect(store.getState().pendingInformationUpdate).not.toBeNull();
    expect(await a.submitInformationUpdate()).toEqual({ ok: true, value: 'UNDER_REVIEW' });
    const audit = (await backend.dev.snapshot()).audit.filter((e) => e.eventType === 'MORE_INFORMATION_PROVIDED');
    expect(audit).toHaveLength(1);
  });
});

describe('waitlist', () => {
  it('stays active, survives restart, never opens the member product, and can return to review', async () => {
    const ctx = await finalReview();
    const { backend, storage, userId } = ctx;
    await backend.dev.advance(userId, 'WAITLISTED');
    await ctx.a.refresh();
    expect(ctx.store.getState().status).toBe('WAITLISTED');

    // Restart: a fresh store hydrates from the device and re-syncs.
    await ctx.store.flush();
    const restarted = createAdmissionStore({ api: backend.api, storage, now: () => NOW });
    await restarted.actions.hydrate();
    expect(restarted.getState().status).toBe('WAITLISTED');
    const s = restarted.getState();
    expect(canAccessMemberProduct(s.status, s.membership)).toBe(false);
    expect(homeRoute(s)).toBe('/application/status');
    expect((await restarted.actions.beginMembership()).ok).toBe(false);

    await backend.dev.review(userId, { kind: 'REOPEN', to: 'FINAL_REVIEW' });
    await restarted.actions.refresh();
    expect(restarted.getState().status).toBe('FINAL_REVIEW');
    expect(restarted.getState().application?.reopenedAt).not.toBeNull();
    expect((await events(ctx)).at(-1)).toMatchObject({ eventType: 'APPLICATION_REOPENED', previousStatus: 'WAITLISTED', newStatus: 'FINAL_REVIEW' });
  });
});

describe('approval and membership activation', () => {
  it('APPROVED is not membership: no member access until the server reports ACTIVE_MEMBER', async () => {
    const ctx = await finalReview();
    const { a, backend, store, userId } = ctx;
    await backend.dev.advance(userId, 'APPROVED');
    await a.refresh();
    let s = store.getState();
    expect(s.status).toBe('APPROVED');
    expect(s.application?.decisionAt).not.toBeNull();
    expect(canAccessMemberProduct(s.status, s.membership)).toBe(false);
    expect(homeRoute(s)).toBe('/application/status');

    expect(await a.beginMembership()).toEqual({ ok: true, value: 'MEMBERSHIP_PAYMENT_REQUIRED' });
    s = store.getState();
    expect(homeRoute(s)).toBe('/membership');
    expect(s.membership?.status).toBe('pending');
    expect(canAccessMemberProduct(s.status, s.membership)).toBe(false);

    const plans = await a.loadMembershipPlans();
    expect(plans.ok && plans.value).toEqual([
      expect.objectContaining({ name: 'Membership', isDevelopmentFixture: true, billingPeriod: 'monthly' }),
    ]);
    // Release builds have no billing provider: activation is refused, nothing changes.
    expect(a.billingAvailable()).toBe(false);
    const plan = plans.ok ? plans.value[0]! : null;
    expect(await a.activateMembership(plan!)).toEqual({ ok: false, error: { kind: 'billing_unavailable' } });
    expect(store.getState().status).toBe('MEMBERSHIP_PAYMENT_REQUIRED');
  });

  it('with the development billing fixture, the server activates and the member product opens', async () => {
    const ctx = await finalReview({ fixtureBilling: true });
    const { a, backend, store, userId } = ctx;
    await backend.dev.advance(userId, 'APPROVED');
    await a.refresh();
    await a.beginMembership();
    const plans = await a.loadMembershipPlans();
    expect(a.billingAvailable()).toBe(true);
    expect(await a.activateMembership(plans.ok ? plans.value[0]! : (null as never))).toEqual({ ok: true, value: 'ACTIVE_MEMBER' });
    const s = store.getState();
    expect(s.membership?.status).toBe('active');
    expect(canAccessMemberProduct(s.status, s.membership)).toBe(true);
    expect(homeRoute(s)).toBe('/member');
    expect((await events(ctx)).slice(-3).map((e) => e.eventType)).toEqual([
      'APPLICATION_APPROVED',
      'MEMBERSHIP_ACTIVATION_STARTED',
      'MEMBERSHIP_ACTIVATED',
    ]);
  });
});

describe('not admitted', () => {
  it('is terminal: no reviewer action, no membership, member routes blocked', async () => {
    const ctx = await finalReview();
    const { a, backend, store, userId } = ctx;
    await backend.dev.advance(userId, 'NOT_ADMITTED');
    await a.refresh();
    const s = store.getState();
    expect(s.status).toBe('NOT_ADMITTED');
    expect(homeRoute(s)).toBe('/application/status');
    expect(canAccessMemberProduct(s.status, s.membership)).toBe(false);
    expect((await a.beginMembership()).ok).toBe(false);
    for (const action of [{ kind: 'APPROVE' }, { kind: 'REOPEN', to: 'UNDER_REVIEW' }, { kind: 'WAITLIST' }] as const) {
      expect((await backend.reviewer.apply(ctx.appId(), action, { reviewerId: 'r' })).ok).toBe(false);
    }
  });
});

describe('dating preferences', () => {
  it('are asked only with Dating, cleared when Dating is unchosen, and kept private', async () => {
    const ctx = await received();
    const { a, backend, store, userId } = ctx;
    await backend.dev.advance(userId, 'UNDER_REVIEW');
    await backend.dev.advance(userId, 'EXTENDED_APPLICATION_REQUIRED');
    await a.refresh();
    await a.beginExtendedApplication();
    a.setIntents(['friendship']);
    expect(a.setMeetPreference(['women'])).toEqual({ ok: false, error: 'not_allowed' });
    a.setIntents(['dating', 'friendship']);
    expect(a.setMeetPreference(['women', 'everyone']).ok).toBe(false); // exclusive
    expect(a.setMeetPreference(['women', 'men']).ok).toBe(true);
    expect(a.setAgeRange({ min: 17, max: 30 }).ok).toBe(false);
    expect(a.setAgeRange({ min: 30, max: 30 }).ok).toBe(false);
    expect(a.setAgeRange({ min: 27, max: 39 }).ok).toBe(true);
    expect(store.getState().extendedDraft.datingPreferences).toEqual({ meet: ['women', 'men'], ageRange: { min: 27, max: 39 } });
    // Persisted on the device while the draft is open.
    await store.flush();
    const restarted = createAdmissionStore({ api: backend.api, storage: ctx.storage, now: () => NOW });
    await restarted.actions.hydrate();
    expect(restarted.getState().extendedDraft.datingPreferences.ageRange).toEqual({ min: 27, max: 39 });
    // Unchoosing Dating removes them.
    a.setIntents(['friendship']);
    expect(store.getState().extendedDraft.datingPreferences).toEqual({ meet: [], ageRange: null });
  });

  it('are stored apart from the application and never reach preview, summary or applicant reads', async () => {
    const ctx = await finalReview({ dating: true });
    const db = await ctx.backend.dev.snapshot();
    const record = db.datingPreferences[ctx.appId()];
    expect(record).toMatchObject({ meet: ['women'], ageRange: { min: 29, max: 41 } });
    expect(JSON.stringify(db.privateData)).not.toContain('ageRange');
    const mine = JSON.stringify(await ctx.backend.api.getMyApplication(ctx.store.getState().session!));
    expect(mine).not.toContain('women');
    expect(mine).not.toContain('ageRange');
    // Device cleared after submission.
    expect(ctx.store.getState().extendedDraft.datingPreferences).toEqual({ meet: [], ageRange: null });
    const preview = buildProfilePreview({
      summary: null,
      fallbackFirstName: 'Şebnem',
      fallbackCity: null,
      extended: {
        photos: [],
        occupation: 'x',
        whatYouDo: null,
        interests: [],
        intents: ['dating'],
        datingPreferences: { meet: ['women'], ageRange: { min: 29, max: 41 } },
      } as never,
    });
    expect(JSON.stringify(preview)).not.toMatch(/women|29|41/);
  });

  it('the server requires them with Dating and refuses them without it', async () => {
    const ctx = await received();
    const { a, backend, store, userId } = ctx;
    await backend.dev.advance(userId, 'UNDER_REVIEW');
    await backend.dev.advance(userId, 'EXTENDED_APPLICATION_REQUIRED');
    await a.refresh();
    await a.beginExtendedApplication();
    const session = store.getState().session!;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const up = await backend.api.uploadApplicationPhoto(session, { dataUri: DATA_URI, width: 1, height: 1 });
      if (up.ok) ids.push(up.value.id);
    }
    const base = {
      photoIds: ids,
      occupation: 'Chef',
      workContext: { kind: 'independent' as const },
      whatYouDo: 'Slow Aegean cooking from a twelve-seat counter in Kadıköy.',
      aboutYou: 'I run a winter supper club for strangers on the Asian side.',
      interests: ['Cooking', 'Wine', 'Travel'],
    };
    const r1 = await backend.api.submitStage2(session, 'k1', { ...base, intents: ['dating'], datingPreferences: null });
    expect(r1).toEqual({ ok: false, error: { kind: 'validation', fields: ['datingPreferences'] } });
    const r2 = await backend.api.submitStage2(session, 'k2', {
      ...base,
      intents: ['friendship'],
      datingPreferences: { meet: ['men'], ageRange: { min: 30, max: 45 } },
    });
    expect(r2).toEqual({ ok: false, error: { kind: 'validation', fields: ['datingPreferences'] } });
  });
});
