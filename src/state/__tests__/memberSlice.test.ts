/**
 * The member vertical slice against the mock server: member access, profile
 * provisioning and privacy, Dating setup and compatibility, finite
 * introductions, idempotent pass/like, mutual matches, messaging, block and
 * report.
 */
import { canAccessMemberProduct } from '@/domain/admission/access';
import { DATING_CATEGORIES, type DatingSettingsInput } from '@/domain/member/dating';
import { DEFAULT_INTRODUCTION_POLICY } from '@/domain/member/introductions';
import { homeRoute } from '@/navigation/routes';
import type { IntroductionsView, MemberApi } from '@/services/api/memberTypes';
import type { Session } from '@/services/api/types';
import { developmentFixtureBilling } from '@/services/billing/billing';
import { createMockAdmissionApi, MOCK_OTP_CODE } from '@/services/mock/mockAdmissionApi';
import { createMemoryStorage } from '@/services/storage';
import { createAdmissionStore } from '../admission/store';
import { createMemberStore } from '../member/memberStore';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

let clock = new Date('2026-10-05T09:00:00.000Z');
const now = () => clock;
const DATA_URI = 'data:image/jpeg;base64,' + 'A'.repeat(64);
const FIXTURE_MEDIA = Object.fromEntries(
  ['elif', 'mert', 'deniz', 'selin', 'can', 'lara', 'emre', 'zeynep', 'aylin', 'kerem'].map((k) => [
    k,
    [`https://qa.invalid/${k}-1.jpg`, `https://qa.invalid/${k}-2.jpg`, `https://qa.invalid/${k}-3.jpg`],
  ]),
);

/** The test member's own Dating setup: a woman open to meeting everyone, 28–37. */
const WOMAN_EVERYONE: DatingSettingsInput = { gender: 'WOMAN', seeking: [...DATING_CATEGORIES], ageRange: { min: 28, max: 37 } };

type Stage = 'FINAL_REVIEW' | 'APPROVED' | 'MEMBERSHIP_PAYMENT_REQUIRED' | 'WAITLISTED' | 'NOT_ADMITTED' | 'ACTIVE_MEMBER';

type Backend = ReturnType<typeof createMockAdmissionApi>;
type Shared = { backend: Backend; storage: ReturnType<typeof createMemoryStorage> };

async function applicant(stage: Stage, opts: { dating?: boolean; phone?: string; backend?: Shared } = {}) {
  // The server's storage, and — separately — this applicant's device storage.
  const storage = opts.backend?.storage ?? createMemoryStorage();
  const backend = opts.backend?.backend ?? createMockAdmissionApi({ storage, now });
  const device = opts.backend ? createMemoryStorage() : storage;
  const billing = developmentFixtureBilling((id) => backend.dev.confirmFixturePayment(id));
  const store = createAdmissionStore({ api: backend.api, storage: device, billing, now });
  const a = store.actions;
  await a.hydrate();
  await a.requestOtp(opts.phone ?? '+905321234567');
  await a.verifyOtp(MOCK_OTP_CODE);
  a.acknowledgeIntro();
  a.setFirstName('Şebnem');
  a.setLastName('Karaosmanoğlu-Büyükçekmeceli');
  a.setDateOfBirth({ day: '14', month: '03', year: '1994' });
  a.setInstagram('sebnem.private');
  a.setCountry('TR');
  a.setCity({ kind: 'listed', cityId: 'TR-istanbul', label: 'İstanbul', region: null });
  a.setReferral({ kind: 'requested', referrals: [{ id: 'r1', name: 'Gökçe Işıklar', phoneE164: '+905551112233' }] });
  await a.submit();
  const userId = store.getState().session!.userId;
  await backend.dev.advance(userId, 'UNDER_REVIEW');
  await backend.dev.advance(userId, 'EXTENDED_APPLICATION_REQUIRED');
  await a.refresh();
  await a.beginExtendedApplication();
  a.acknowledgeExtendedIntro();
  for (let i = 0; i < 3; i++) await a.addPhoto({ uri: `file:///p${i}.jpg`, dataUri: DATA_URI, width: 720, height: 960 });
  a.setOccupation('Restoration architect');
  a.setWorkContext({ kind: 'organisation', name: 'Atölye Kuzguncuk' });
  a.setWhatYouDo('Restoring wooden yalı houses on the Asian shore with a small team of carpenters.');
  a.setAboutYou('PRIVATE-ABOUT-YOU: I swim in the Bosphorus every morning from May until the water turns.');
  a.setInterests(['Architecture', 'Swimming', 'Jazz']);
  if (opts.dating ?? true) {
    a.setIntents(['dating', 'community']);
    a.setMeetPreference(['everyone']);
    a.setAgeRange({ min: 28, max: 37 });
  } else {
    a.setIntents(['friendship', 'community']);
  }
  a.markPreviewSeen();
  await a.submitExtended();
  if (stage === 'WAITLISTED' || stage === 'NOT_ADMITTED') await backend.dev.advance(userId, stage);
  if (stage === 'APPROVED' || stage === 'MEMBERSHIP_PAYMENT_REQUIRED' || stage === 'ACTIVE_MEMBER') {
    await backend.dev.advance(userId, 'APPROVED');
  }
  await a.refresh();
  if (stage === 'MEMBERSHIP_PAYMENT_REQUIRED' || stage === 'ACTIVE_MEMBER') await a.beginMembership();
  if (stage === 'ACTIVE_MEMBER') {
    const plans = await a.loadMembershipPlans();
    await a.activateMembership(plans.ok ? plans.value[0]! : (null as never));
  }
  const session = store.getState().session as Session;
  const m: MemberApi = backend.member;
  return { storage, backend, store, a, userId, session, m };
}

/**
 * An active member. Dating members complete Dating setup (unless `setup` is
 * false) BEFORE the community is seeded: the admirer's like goes through the
 * real eligibility check, which needs the member's identity.
 */
async function member(
  opts: { dating?: boolean; seed?: boolean; setup?: DatingSettingsInput | false; phone?: string; backend?: Shared } = {},
) {
  const ctx = await applicant('ACTIVE_MEMBER', opts);
  if ((opts.dating ?? true) && opts.setup !== false) value(await ctx.m.saveDatingSettings(ctx.session, opts.setup ?? WOMAN_EVERYONE));
  if (opts.seed ?? true) await ctx.backend.dev.seedCommunity({ media: FIXTURE_MEDIA, admirerOf: ctx.userId });
  return ctx;
}
type Ctx = Awaited<ReturnType<typeof applicant>>;

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`Expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};

async function introductions(ctx: Ctx): Promise<IntroductionsView> {
  return value(await ctx.m.getIntroductions(ctx.session));
}

const names = (v: IntroductionsView) => v.waiting.map((w) => w.member.displayName);
/** Today's introduction of a named member: the id a reaction answers, and their member id. */
async function intro(ctx: Ctx, name: string) {
  const w = (await introductions(ctx)).waiting.find((x) => x.member.displayName === name);
  if (!w) throw new Error(`${name} is not introduced today`);
  return { introductionId: w.introductionId, memberId: w.member.memberId };
}

beforeEach(() => {
  clock = new Date('2026-10-05T09:00:00.000Z');
});

describe('member access', () => {
  it.each([
    ['APPROVED'],
    ['MEMBERSHIP_PAYMENT_REQUIRED'],
    ['WAITLISTED'],
    ['NOT_ADMITTED'],
    ['FINAL_REVIEW'],
  ] as const)('%s cannot enter: guard closed and every member call refused', async (stage) => {
    const ctx = await applicant(stage);
    const s = ctx.store.getState();
    expect(s.status).toBe(stage);
    expect(canAccessMemberProduct(s.status, s.membership)).toBe(false);
    expect(homeRoute(s)).not.toBe('/member');
    await ctx.backend.dev.seedCommunity({ media: FIXTURE_MEDIA });
    const calls = [
      ctx.m.getMe(ctx.session),
      ctx.m.getIntroductions(ctx.session),
      ctx.m.getDatingSettings(ctx.session),
      ctx.m.saveDatingSettings(ctx.session, WOMAN_EVERYONE),
      ctx.m.listConversations(ctx.session),
      ctx.m.react(ctx.session, 'itr_x', 'LIKE'),
      ctx.m.getMemberProfile(ctx.session, 'mem_x'),
    ];
    for (const r of await Promise.all(calls)) expect(r).toEqual({ ok: false, error: { kind: 'membership_required' } });
    // No member profile (and no Dating record) was created for an applicant.
    const db = await ctx.backend.dev.snapshot();
    expect(db.memberIdByUser[ctx.userId]).toBeUndefined();
    // (only the seeded fixture members' completed records exist)
    expect(Object.values(db.datingSettings).every((d) => d.setupCompletedAt !== null)).toBe(true);
  });

  it('an active member can enter, and the server provisioned the profile at activation', async () => {
    const ctx = await member({ seed: false, setup: false });
    const s = ctx.store.getState();
    expect(canAccessMemberProduct(s.status, s.membership)).toBe(true);
    expect(homeRoute(s)).toBe('/member');
    const db = await ctx.backend.dev.snapshot();
    expect(db.memberIdByUser[ctx.userId]).toBeDefined();
    const me = value(await ctx.m.getMe(ctx.session));
    expect(me.membership.status).toBe('active');
    expect(me.profile.confirmedAt).toBeNull();
  });

  it('an invalid session is unauthorized', async () => {
    const ctx = await member({ seed: false });
    expect(await ctx.m.getMe({ token: 'nope', userId: ctx.userId })).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });
});

describe('member profile', () => {
  it('renders the public fields generated from the approved application', async () => {
    const ctx = await member({ seed: false });
    const { profile } = value(await ctx.m.getMe(ctx.session));
    expect(profile).toMatchObject({
      displayName: 'Şebnem',
      age: 32,
      occupation: 'Restoration architect',
      cityLabel: 'İstanbul',
      knownFor: 'Restoring wooden yalı houses on the Asian shore with a small team of carpenters.',
      interests: ['Architecture', 'Swimming', 'Jazz'],
      intents: ['dating', 'community'],
    });
    expect(profile.photos).toHaveLength(3);
  });

  it('never contains private application fields', async () => {
    const ctx = await member();
    const own = JSON.stringify(value(await ctx.m.getMe(ctx.session)));
    // What another member receives about this member: the admirer's view after a match.
    const deniz = await intro(ctx, 'Deniz');
    const res = value(await ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'));
    const matchSeenByMe = JSON.stringify(res.match);
    for (const json of [own, matchSeenByMe]) {
      expect(json).not.toContain('Karaosmanoğlu');
      expect(json).not.toContain('1994');
      expect(json).not.toContain('+90532');
      expect(json).not.toContain('sebnem.private');
      expect(json).not.toContain('Gökçe');
      expect(json).not.toContain('PRIVATE-ABOUT-YOU');
      expect(json).not.toContain('ageRange');
      expect(json).not.toContain('"meet"');
      expect(json).not.toContain('seeking');
      expect(json).not.toContain('"WOMAN"');
      expect(json).not.toContain(ctx.userId);
    }
  });

  it('confirmation is recorded once, on the server', async () => {
    const ctx = await member({ seed: false });
    const first = value(await ctx.m.confirmProfile(ctx.session)).profile.confirmedAt;
    expect(first).not.toBeNull();
    clock = new Date('2026-10-05T10:00:00.000Z');
    expect(value(await ctx.m.confirmProfile(ctx.session)).profile.confirmedAt).toBe(first);
  });

  it('editing changes the public profile only — application records stay as approved', async () => {
    const ctx = await member({ seed: false });
    const before = await ctx.backend.dev.snapshot();
    const { profile } = value(await ctx.m.getMe(ctx.session));
    const [p1, p2, p3] = profile.photos.map((p) => p.id);
    const edited = value(
      await ctx.m.updateProfile(ctx.session, {
        occupation: 'Architect',
        cityLabel: 'Ayvalık',
        knownFor: 'Restoring olive-oil factories on the north Aegean coast, one roof at a time.',
        interests: ['Architecture', 'Sailing', 'Books', 'Wine'],
        photoOrder: [p3!, p1!, p2!],
      }),
    );
    expect(edited.profile).toMatchObject({ occupation: 'Architect', cityLabel: 'Ayvalık', interests: ['Architecture', 'Sailing', 'Books', 'Wine'] });
    expect(edited.profile.photos.map((p) => p.id)).toEqual([p3, p1, p2]);
    const after = await ctx.backend.dev.snapshot();
    expect(after.privateData).toEqual(before.privateData);
    expect(after.applications).toEqual(before.applications);
    expect(after.media).toEqual(before.media);
    expect(after.audit).toEqual(before.audit);
    expect(after.datingSettings).toEqual(before.datingSettings);
  });

  it('refuses invalid edits and application-only fields', async () => {
    const ctx = await member({ seed: false });
    expect(await ctx.m.updateProfile(ctx.session, { interests: ['Yachts'] })).toEqual({
      ok: false,
      error: { kind: 'validation', fields: ['interests'] },
    });
    expect(await ctx.m.updateProfile(ctx.session, { photoOrder: ['mmd_someone_else'] })).toEqual({
      ok: false,
      error: { kind: 'validation', fields: ['photoOrder'] },
    });
    // Unknown keys (e.g. surname, or Dating identity through the profile) are ignored, never applied.
    const res = value(await ctx.m.updateProfile(ctx.session, { lastName: 'X', gender: 'MAN', occupation: 'Architect' } as never));
    expect(JSON.stringify(res)).not.toContain('"lastName"');
    expect(JSON.stringify(res)).not.toContain('gender');
    const db = await ctx.backend.dev.snapshot();
    expect(Object.values(db.privateData).find((p) => p.firstName === 'Şebnem')!.lastName).toBe('Karaosmanoğlu-Büyükçekmeceli');
    expect(value(await ctx.m.getDatingSettings(ctx.session)).identity?.gender).toBe('WOMAN');
  });
});

describe('Dating setup (after activation, only for Dating members)', () => {
  it('a Dating member must describe themselves before any introduction; preferences are pre-filled from the application', async () => {
    const ctx = await member({ setup: false, seed: false });
    expect(value(await ctx.m.getMe(ctx.session)).dating).toEqual({ usesDating: true, setupRequired: true });
    expect(value(await ctx.m.getDatingSettings(ctx.session))).toEqual({
      usesDating: true,
      identity: null, // never inferred — not from the name, photos, Instagram or anything else
      seeking: ['WOMAN', 'MAN', 'NON_BINARY'], // "Everyone" on the application
      ageRange: { min: 28, max: 37 },
      setupCompletedAt: null,
    });
    await ctx.backend.dev.seedCommunity({ media: FIXTURE_MEDIA, admirerOf: ctx.userId });
    expect(await introductions(ctx)).toMatchObject({ state: 'DATING_SETUP_REQUIRED', batchId: null, waiting: [] });
    // Nobody can be introduced to — or like — a member without Dating setup.
    const db = await ctx.backend.dev.snapshot();
    const me = db.memberIdByUser[ctx.userId]!;
    expect(Object.values(db.introductionEntries).filter((e) => e.candidateId === me || e.viewerId === me)).toEqual([]);
    expect(Object.values(db.reactions).filter((r) => r.toMemberId === me)).toEqual([]);
  });

  it('completing setup opens introductions', async () => {
    const ctx = await member({ setup: false, seed: false });
    const saved = value(await ctx.m.saveDatingSettings(ctx.session, WOMAN_EVERYONE));
    expect(saved).toMatchObject({ identity: { gender: 'WOMAN', selfDescription: null, appearsAs: ['WOMAN'] }, setupCompletedAt: '2026-10-05T09:00:00.000Z' });
    expect(value(await ctx.m.getMe(ctx.session)).dating).toEqual({ usesDating: true, setupRequired: false });
    await ctx.backend.dev.seedCommunity({ media: FIXTURE_MEDIA });
    expect((await introductions(ctx)).state).toBe('READY');
  });

  it('validates every answer on the server', async () => {
    const ctx = await member({ setup: false, seed: false });
    const bad = (input: unknown) => ctx.m.saveDatingSettings(ctx.session, input as DatingSettingsInput);
    expect(await bad({ ...WOMAN_EVERYONE, gender: 'ROBOT' })).toEqual({ ok: false, error: { kind: 'validation', fields: ['gender'] } });
    expect(await bad({ ...WOMAN_EVERYONE, seeking: [] })).toEqual({ ok: false, error: { kind: 'validation', fields: ['seeking'] } });
    expect(await bad({ ...WOMAN_EVERYONE, seeking: ['ROBOTS'] })).toEqual({ ok: false, error: { kind: 'validation', fields: ['seeking'] } });
    expect(await bad({ ...WOMAN_EVERYONE, ageRange: { min: 40, max: 30 } })).toEqual({ ok: false, error: { kind: 'validation', fields: ['ageRange'] } });
    expect(await bad({ ...WOMAN_EVERYONE, ageRange: { min: 16, max: 30 } })).toEqual({ ok: false, error: { kind: 'validation', fields: ['ageRange'] } });
    // Self-described: private words AND the categories to be included under — both required.
    expect(await bad({ ...WOMAN_EVERYONE, gender: 'SELF_DESCRIBED', selfDescription: '  ', appearsAs: ['NON_BINARY'] })).toEqual({
      ok: false,
      error: { kind: 'validation', fields: ['selfDescription'] },
    });
    expect(await bad({ ...WOMAN_EVERYONE, gender: 'SELF_DESCRIBED', selfDescription: 'Genderqueer', appearsAs: [] })).toEqual({
      ok: false,
      error: { kind: 'validation', fields: ['appearsAs'] },
    });
    expect(await bad({ ...WOMAN_EVERYONE, gender: 'SELF_DESCRIBED', selfDescription: 'x'.repeat(41), appearsAs: ['WOMAN'] })).toEqual({
      ok: false,
      error: { kind: 'validation', fields: ['selfDescription'] },
    });
    expect(value(await ctx.m.getMe(ctx.session)).dating.setupRequired).toBe(true);
  });

  it('a fixed answer decides its own category; a client cannot smuggle extra categories', async () => {
    const ctx = await member({ setup: false, seed: false });
    const saved = value(
      await ctx.m.saveDatingSettings(ctx.session, { ...WOMAN_EVERYONE, gender: 'MAN', selfDescription: 'ignored', appearsAs: ['WOMAN', 'NON_BINARY'] }),
    );
    expect(saved.identity).toEqual({ gender: 'MAN', selfDescription: null, appearsAs: ['MAN'] });
  });

  it('members not using Dating are never asked, never introduced and get no introductions', async () => {
    const ctx = await member({ dating: false });
    expect(value(await ctx.m.getMe(ctx.session)).dating).toEqual({ usesDating: false, setupRequired: false });
    expect(await introductions(ctx)).toMatchObject({ state: 'NOT_USING_DATING', batchId: null, waiting: [], hadIntroductions: false });
    expect(await ctx.m.saveDatingSettings(ctx.session, WOMAN_EVERYONE)).toEqual({ ok: false, error: { kind: 'not_allowed' } });
    expect(value(await ctx.m.getDatingSettings(ctx.session))).toEqual({
      usesDating: false,
      identity: null,
      seeking: [],
      ageRange: null,
      setupCompletedAt: null,
    });
    // The admirer could not introduce themselves; no fixture member's batch contains this member.
    const db = await ctx.backend.dev.snapshot();
    const me = db.memberIdByUser[ctx.userId]!;
    expect(db.datingSettings[me]).toBeUndefined();
    expect(Object.values(db.introductionEntries).filter((e) => e.candidateId === me)).toEqual([]);
  });
});

describe("today's introductions", () => {
  it('is a finite, curated batch of eligible members: no duplicates, never yourself, never refilled', async () => {
    const ctx = await member();
    const first = await introductions(ctx);
    expect(first.state).toBe('READY');
    expect(first.waiting.length).toBeLessThanOrEqual(DEFAULT_INTRODUCTION_POLICY.perDay);
    // A woman open to everyone, 28–37: the dating members who would also like to meet her.
    expect(names(first)).toEqual(['Kerem', 'Selin', 'Deniz', 'Zeynep', 'Mert']);
    expect(first.waiting.every((w) => w.context === 'DATING')).toBe(true);
    const ids = first.waiting.map((w) => w.member.memberId);
    expect(new Set(ids).size).toBe(ids.length);
    const me = value(await ctx.m.getMe(ctx.session)).profile.memberId;
    expect(ids).not.toContain(me);
    // The same batch all day.
    const again = await introductions(ctx);
    expect(again.batchId).toBe(first.batchId);
    // Responding never refills it.
    for (const w of first.waiting) value(await ctx.m.react(ctx.session, w.introductionId, 'PASS'));
    const done = await introductions(ctx);
    expect(done.waiting).toEqual([]);
    expect(done.hadIntroductions).toBe(true);
    expect(done.batchId).toBe(first.batchId);
  });

  it('excludes members outside the age range, members who would not meet her, and members not using Dating', async () => {
    const ctx = await member();
    const shown = names(await introductions(ctx));
    expect(shown).not.toContain('Can'); // 38 — outside her 28–37
    expect(shown).not.toContain('Emre'); // looking to meet men
    for (const friend of ['Elif', 'Lara', 'Aylin']) expect(shown).not.toContain(friend); // not using Dating
  });

  it('follows her preferences: looking for women only', async () => {
    const ctx = await member({ setup: { ...WOMAN_EVERYONE, seeking: ['WOMAN'] } });
    expect(names(await introductions(ctx))).toEqual(['Selin', 'Zeynep']);
  });

  it('follows her identity: a man looking for women meets the women looking for men', async () => {
    const ctx = await member({ setup: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 28, max: 37 } } });
    // Selin looks for men; Zeynep is open to everyone and appears as a woman. Nobody else qualifies.
    expect(names(await introductions(ctx))).toEqual(['Selin', 'Zeynep']);
  });

  it('a self-described member appears only under the categories they chose', async () => {
    const ctx = await member({
      setup: { gender: 'SELF_DESCRIBED', selfDescription: 'Genderqueer, mostly', appearsAs: ['NON_BINARY'], seeking: [...DATING_CATEGORIES], ageRange: { min: 28, max: 37 } },
    });
    // Only members looking to meet non-binary people: Kerem and Zeynep. The words themselves are never classified.
    expect(names(await introductions(ctx))).toEqual(['Kerem', 'Zeynep']);
  });

  it('a pass removes the introduction, and the member is not reintroduced within the cooldown', async () => {
    const ctx = await member();
    const kerem = await intro(ctx, 'Kerem');
    expect(value(await ctx.m.react(ctx.session, kerem.introductionId, 'PASS'))).toEqual({ type: 'PASS', match: null });
    expect(names(await introductions(ctx))).not.toContain('Kerem');
    clock = new Date('2026-10-25T09:00:00.000Z'); // 20 days: past the re-introduction window, inside the pass cooldown
    expect((await introductions(ctx)).waiting.map((w) => w.member.memberId)).not.toContain(kerem.memberId);
    clock = new Date('2026-11-06T09:00:00.000Z'); // 32 days
    expect((await introductions(ctx)).waiting.map((w) => w.member.memberId)).toContain(kerem.memberId);
  });

  it('members already introduced are not repeated tomorrow, and return after the window', async () => {
    const ctx = await member();
    await introductions(ctx); // today's batch, unanswered
    clock = new Date('2026-10-06T09:00:00.000Z');
    const tomorrow = await introductions(ctx);
    expect(tomorrow.waiting).toEqual([]);
    expect(tomorrow.hadIntroductions).toBe(false);
    clock = new Date('2026-10-21T09:00:00.000Z'); // 16 days later
    expect(names(await introductions(ctx))).toEqual(['Kerem', 'Selin', 'Deniz', 'Zeynep', 'Mert']);
  });

  it('a liked member and a matched member are never reintroduced', async () => {
    const ctx = await member();
    value(await ctx.m.react(ctx.session, (await intro(ctx, 'Mert')).introductionId, 'LIKE'));
    value(await ctx.m.react(ctx.session, (await intro(ctx, 'Deniz')).introductionId, 'LIKE')); // a match
    clock = new Date('2026-12-20T09:00:00.000Z');
    const later = names(await introductions(ctx));
    expect(later).not.toContain('Mert');
    expect(later).not.toContain('Deniz');
    expect(later).toContain('Kerem');
  });

  it('blocked members never appear — today or later', async () => {
    const ctx = await member();
    const mert = await intro(ctx, 'Mert');
    value(await ctx.m.blockMember(ctx.session, mert.memberId));
    expect(names(await introductions(ctx))).not.toContain('Mert');
    expect(await ctx.m.getMemberProfile(ctx.session, mert.memberId)).toEqual({ ok: false, error: { kind: 'not_available' } });
    expect(await ctx.m.react(ctx.session, mert.introductionId, 'LIKE')).toEqual({ ok: false, error: { kind: 'not_eligible' } });
    clock = new Date('2026-11-20T09:00:00.000Z');
    expect((await introductions(ctx)).waiting.map((w) => w.member.memberId)).not.toContain(mert.memberId);
  });

  it('a member blocked by someone else is not introduced to them', async () => {
    const ctx = await member();
    await ctx.backend.dev.memberBlocks('selin', ctx.userId);
    expect(names(await introductions(ctx))).not.toContain('Selin');
  });

  it('a member whose membership lapses is withdrawn from waiting introductions', async () => {
    const ctx = await member();
    const kerem = await intro(ctx, 'Kerem');
    await ctx.backend.dev.expireMembership('usr_fx_kerem');
    expect(names(await introductions(ctx))).not.toContain('Kerem');
    expect(await ctx.m.react(ctx.session, kerem.introductionId, 'LIKE')).toEqual({ ok: false, error: { kind: 'not_eligible' } });
    expect(await ctx.m.getMemberProfile(ctx.session, kerem.memberId)).toEqual({ ok: false, error: { kind: 'not_available' } });
  });

  it("a member's own lapsed membership closes the member API", async () => {
    const ctx = await member();
    await ctx.backend.dev.expireMembership(ctx.userId);
    expect(await ctx.m.getIntroductions(ctx.session)).toEqual({ ok: false, error: { kind: 'membership_required' } });
    const db = await ctx.backend.dev.snapshot();
    expect(db.applications[ctx.userId]!.status).toBe('EXPIRED');
    expect(Object.values(db.audit).some((e) => e.eventType === 'MEMBERSHIP_EXPIRED' && e.userId === ctx.userId)).toBe(true);
  });
});

describe('changing Dating preferences', () => {
  it('affects introductions from now on, and keeps existing matches and conversations', async () => {
    const ctx = await member();
    const deniz = await intro(ctx, 'Deniz');
    const { match } = value(await ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'));
    const conv = value(await ctx.m.openConversation(ctx.session, match!.matchId));
    value(await ctx.m.sendMessage(ctx.session, conv.conversationId, 'Merhaba', 'cm_1'));
    const kerem = await intro(ctx, 'Kerem');

    value(await ctx.m.saveDatingSettings(ctx.session, { ...WOMAN_EVERYONE, seeking: ['WOMAN'] }));

    // Men still waiting today are withdrawn; a stale tap is refused, not recorded.
    expect(names(await introductions(ctx))).toEqual(['Selin', 'Zeynep']);
    expect(await ctx.m.react(ctx.session, kerem.introductionId, 'LIKE')).toEqual({ ok: false, error: { kind: 'not_eligible' } });
    expect(await ctx.m.getMemberProfile(ctx.session, kerem.memberId)).toEqual({ ok: false, error: { kind: 'not_available' } });
    // The match and its conversation remain.
    expect(value(await ctx.m.listConversations(ctx.session)).map((c) => c.other.displayName)).toEqual(['Deniz']);
    expect(value(await ctx.m.openConversation(ctx.session, match!.matchId)).messages.map((m) => m.body)).toEqual(['Merhaba']);
    expect(value(await ctx.m.getMemberProfile(ctx.session, deniz.memberId)).displayName).toBe('Deniz');
  });
});

describe('likes and matches', () => {
  it('a like persists, and a like alone does not create a match', async () => {
    const ctx = await member();
    const mert = await intro(ctx, 'Mert');
    expect(value(await ctx.m.react(ctx.session, mert.introductionId, 'LIKE'))).toEqual({ type: 'LIKE', match: null });
    // Persisted on the server: a fresh server instance over the same storage still has it.
    const reopened = createMockAdmissionApi({ storage: ctx.storage, now });
    const db = await reopened.dev.snapshot();
    expect(Object.values(db.reactions).some((r) => r.toMemberId === mert.memberId && r.type === 'LIKE' && r.introductionId === mert.introductionId)).toBe(true);
    expect(Object.values(db.matches).filter((m) => m.memberIds.includes(mert.memberId))).toHaveLength(0);
    expect(value(await ctx.m.listConversations(ctx.session))).toEqual([]);
  });

  it('the deterministic fixture: liking the admirer back creates exactly one mutual match', async () => {
    const ctx = await member();
    const before = await ctx.backend.dev.snapshot();
    expect(Object.keys(before.matches)).toHaveLength(0);
    const deniz = await intro(ctx, 'Deniz');
    const res = value(await ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'));
    expect(res.match).toMatchObject({ other: { displayName: 'Deniz', age: 34 }, self: { displayName: 'Şebnem' }, conversationId: null });
    const db = await ctx.backend.dev.snapshot();
    expect(Object.keys(db.matches)).toHaveLength(1);
    const list = value(await ctx.m.listConversations(ctx.session));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ other: { displayName: 'Deniz' }, conversationId: null, lastMessage: null, unread: true });
  });

  it('reactions are idempotent: a retry replays, a different answer is refused, a double tap makes one match', async () => {
    const ctx = await member();
    const deniz = await intro(ctx, 'Deniz');
    // A double tap: two identical requests in flight.
    const [a, b] = await Promise.all([
      ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'),
      ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'),
    ]);
    const first = value(a);
    expect(value(b)).toEqual(first);
    // A later retry replays the same result.
    expect(value(await ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'))).toEqual(first);
    // Changing the answer is not possible.
    expect(await ctx.m.react(ctx.session, deniz.introductionId, 'PASS')).toEqual({ ok: false, error: { kind: 'reaction_already_recorded' } });
    const db = await ctx.backend.dev.snapshot();
    expect(Object.keys(db.matches)).toHaveLength(1);
    expect(Object.values(db.reactions).filter((r) => r.introductionId === deniz.introductionId)).toHaveLength(1);
  });

  it('the client cannot fabricate a match or react to an introduction that is not theirs', async () => {
    const ctx = await member();
    const db = await ctx.backend.dev.snapshot();
    const can = db.memberIdByUser['usr_fx_can']!; // never introduced to her
    // The admirer's introduction to her exists, but it is the admirer's, not hers.
    const denizId = db.memberIdByUser['usr_fx_deniz']!;
    const theirs = Object.values(db.introductionEntries).find((e) => e.viewerId === denizId)!;
    expect(await ctx.m.react(ctx.session, theirs.id, 'LIKE')).toEqual({ ok: false, error: { kind: 'introduction_not_found' } });
    expect(await ctx.m.react(ctx.session, 'itr_invented', 'LIKE')).toEqual({ ok: false, error: { kind: 'introduction_not_found' } });
    expect(await ctx.m.getMemberProfile(ctx.session, can)).toEqual({ ok: false, error: { kind: 'not_available' } });
    expect(await ctx.m.react(ctx.session, (await intro(ctx, 'Kerem')).introductionId, 'SUPER' as never)).toEqual({
      ok: false,
      error: { kind: 'validation', fields: ['type'] },
    });
    expect(await ctx.m.getMatch(ctx.session, 'mch_invented')).toEqual({ ok: false, error: { kind: 'match_not_found' } });
  });

  it("yesterday's introduction has expired", async () => {
    const ctx = await member();
    const kerem = await intro(ctx, 'Kerem');
    clock = new Date('2026-10-06T09:00:00.000Z');
    expect(await ctx.m.react(ctx.session, kerem.introductionId, 'LIKE')).toEqual({ ok: false, error: { kind: 'introduction_expired' } });
  });
});

describe('messaging', () => {
  async function matched() {
    const ctx = await member();
    const deniz = await intro(ctx, 'Deniz');
    const { match } = value(await ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'));
    return { ...ctx, deniz: deniz.memberId, match: match! };
  }

  it('only matched members can open a conversation', async () => {
    const ctx = await matched();
    await ctx.m.react(ctx.session, (await intro(ctx, 'Mert')).introductionId, 'LIKE');
    expect(await ctx.m.openConversation(ctx.session, 'mch_invented')).toEqual({ ok: false, error: { kind: 'match_not_found' } });
    // A second member cannot open someone else's match.
    const other = await member({ phone: '+905329998877', backend: { backend: ctx.backend, storage: ctx.storage }, seed: false });
    expect(await other.m.openConversation(other.session, ctx.match.matchId)).toEqual({ ok: false, error: { kind: 'match_not_found' } });
    // A fixture member without a match cannot write either.
    await expect(ctx.backend.dev.memberSays('mert', ctx.userId, 'Hello')).rejects.toThrow(/No active match/);
    const view = value(await ctx.m.openConversation(ctx.session, ctx.match.matchId));
    expect(view).toMatchObject({ matchId: ctx.match.matchId, other: { displayName: 'Deniz' }, messages: [] });
    // …nor can the second member write into it.
    expect(await other.m.sendMessage(other.session, view.conversationId, 'Hi', 'cm_x')).toEqual({ ok: false, error: { kind: 'conversation_forbidden' } });
  });

  it('sends text, idempotently, and validates it', async () => {
    const ctx = await matched();
    const { conversationId } = value(await ctx.m.openConversation(ctx.session, ctx.match.matchId));
    const sent = value(await ctx.m.sendMessage(ctx.session, conversationId, '  Merhaba Deniz — Tophane next week?  ', 'cm_1'));
    expect(sent).toMatchObject({ fromSelf: true, body: 'Merhaba Deniz — Tophane next week?' });
    expect(value(await ctx.m.sendMessage(ctx.session, conversationId, 'Merhaba Deniz — Tophane next week?', 'cm_1')).id).toBe(sent.id);
    expect(await ctx.m.sendMessage(ctx.session, conversationId, '   ', 'cm_2')).toEqual({ ok: false, error: { kind: 'validation', fields: ['empty'] } });
    expect(await ctx.m.sendMessage(ctx.session, conversationId, 'x'.repeat(2001), 'cm_3')).toEqual({ ok: false, error: { kind: 'validation', fields: ['too_long'] } });
    clock = new Date('2026-10-05T09:04:00.000Z');
    await ctx.backend.dev.memberSays('deniz', ctx.userId, 'Gladly. Thursday?');
    const list = value(await ctx.m.listConversations(ctx.session));
    expect(list[0]).toMatchObject({ lastMessage: { body: 'Gladly. Thursday?', fromSelf: false }, unread: true });
    const thread = value(await ctx.m.openConversation(ctx.session, ctx.match.matchId)).messages;
    expect(thread.map((m) => [m.fromSelf, m.body])).toEqual([
      [true, 'Merhaba Deniz — Tophane next week?'],
      [false, 'Gladly. Thursday?'],
    ]);
    expect(value(await ctx.m.listConversations(ctx.session))[0]!.unread).toBe(false);
  });

  it('a block ends the conversation for both sides: no new messages, no profile, not listed — records kept', async () => {
    const ctx = await matched();
    const { conversationId } = value(await ctx.m.openConversation(ctx.session, ctx.match.matchId));
    value(await ctx.m.sendMessage(ctx.session, conversationId, 'Hello', 'cm_1'));
    value(await ctx.m.blockMember(ctx.session, ctx.deniz));
    expect(await ctx.m.sendMessage(ctx.session, conversationId, 'Still there?', 'cm_2')).toEqual({ ok: false, error: { kind: 'conversation_forbidden' } });
    expect(await ctx.m.openConversation(ctx.session, ctx.match.matchId)).toEqual({ ok: false, error: { kind: 'match_not_found' } });
    expect(await ctx.m.getMemberProfile(ctx.session, ctx.deniz)).toEqual({ ok: false, error: { kind: 'not_available' } });
    expect(value(await ctx.m.listConversations(ctx.session))).toEqual([]);
    // The blocked member cannot write either (and is not told why).
    await expect(ctx.backend.dev.memberSays('deniz', ctx.userId, 'Hi?')).rejects.toThrow();
    const blocked = value(await ctx.m.listBlocked(ctx.session));
    expect(blocked).toEqual([expect.objectContaining({ memberId: ctx.deniz, displayName: 'Deniz' })]);
    // Safety evidence is preserved: the match is ended, not deleted; messages remain.
    const db = await ctx.backend.dev.snapshot();
    expect(db.matches[ctx.match.matchId]!.endedAt).not.toBeNull();
    expect(Object.values(db.messages).map((m) => m.body)).toEqual(['Hello']);
    // Blocking again is idempotent.
    expect(value(await ctx.m.blockMember(ctx.session, ctx.deniz))).toEqual({ blocked: true });
  });

  it('when the other member blocks, the conversation simply becomes unavailable', async () => {
    const ctx = await matched();
    const { conversationId } = value(await ctx.m.openConversation(ctx.session, ctx.match.matchId));
    await ctx.backend.dev.memberBlocks('deniz', ctx.userId);
    expect(await ctx.m.sendMessage(ctx.session, conversationId, 'Hello?', 'cm_9')).toEqual({ ok: false, error: { kind: 'conversation_forbidden' } });
    expect(value(await ctx.m.listConversations(ctx.session))).toEqual([]);
    expect(value(await ctx.m.listBlocked(ctx.session))).toEqual([]);
  });

  it('reports are structured and recorded for the membership team', async () => {
    const ctx = await matched();
    expect(await ctx.m.reportMember(ctx.session, ctx.deniz, { reason: 'NOPE' as never, context: 'profile' })).toEqual({
      ok: false,
      error: { kind: 'validation', fields: ['reason'] },
    });
    value(await ctx.m.reportMember(ctx.session, ctx.deniz, { reason: 'HARASSMENT', context: 'conversation', conversationId: null }));
    const db = await ctx.backend.dev.snapshot();
    expect(Object.values(db.reports)).toEqual([expect.objectContaining({ reportedId: ctx.deniz, reason: 'HARASSMENT', status: 'open' })]);
    // Unknown members cannot be reported (no enumeration).
    expect(await ctx.m.reportMember(ctx.session, 'mem_nobody', { reason: 'OTHER', context: 'profile' })).toEqual({ ok: false, error: { kind: 'not_available' } });
  });
});

describe('privacy across every member response', () => {
  it('no surname, phone, date of birth, referral, Instagram, account id or coordinates', async () => {
    const ctx = await member();
    const deniz = await intro(ctx, 'Deniz');
    const { match } = value(await ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'));
    const conv = value(await ctx.m.openConversation(ctx.session, match!.matchId));
    await ctx.backend.dev.memberSays('deniz', ctx.userId, 'Hello from Tophane.');
    const responses = [
      await ctx.m.getIntroductions(ctx.session),
      await ctx.m.getMemberProfile(ctx.session, deniz.memberId),
      await ctx.m.getMatch(ctx.session, match!.matchId),
      await ctx.m.listConversations(ctx.session),
      await ctx.m.openConversation(ctx.session, conv.matchId),
      await ctx.m.listBlocked(ctx.session),
    ];
    const json = JSON.stringify(responses);
    for (const forbidden of [
      'Aksoylu', 'Kaptanoğlu', 'Erdinç', 'Demirtaş', // fixture surnames
      '1992-02-11', '1995-06-02', // fixture dates of birth
      '+90500', // fixture phones
      '.fixture', // fixture Instagram handles
      'usr_', // account ids
      'latitude', 'longitude', '"lat"', '"lng"', 'coordinates',
      'ageRange', 'datingPreferences', 'referral',
    ]) {
      expect(json).not.toContain(forbidden);
    }
    for (const r of responses) expect(r.ok).toBe(true);
  });

  it("the client never receives another member's Dating identity or preferences", async () => {
    // Zeynep (self-described "Genderfluid", seeking everyone) is in this batch.
    const ctx = await member();
    const zeynep = await intro(ctx, 'Zeynep');
    const deniz = await intro(ctx, 'Deniz');
    const { match } = value(await ctx.m.react(ctx.session, deniz.introductionId, 'LIKE'));
    const json = JSON.stringify([
      await ctx.m.getIntroductions(ctx.session),
      await ctx.m.getMemberProfile(ctx.session, zeynep.memberId),
      await ctx.m.getMemberProfile(ctx.session, deniz.memberId),
      await ctx.m.getMatch(ctx.session, match!.matchId),
      await ctx.m.listConversations(ctx.session),
    ]);
    for (const forbidden of ['Genderfluid', 'selfDescription', 'SELF_DESCRIBED', 'gender', 'appearsAs', 'seeking', '"WOMAN"', '"MAN"', 'NON_BINARY', 'ageRange', '"min"', '"max"']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("another member sees a self-described member's profile — never the words or categories behind the match", async () => {
    const shared = await member({
      setup: { gender: 'SELF_DESCRIBED', selfDescription: 'PRIVATE-WORDS genderqueer', appearsAs: ['WOMAN'], seeking: [...DATING_CATEGORIES], ageRange: { min: 28, max: 37 } },
    });
    const a = value(await shared.m.getMe(shared.session)).profile.memberId;
    const b = await member({
      phone: '+905329998877',
      backend: { backend: shared.backend, storage: shared.storage },
      setup: { gender: 'WOMAN', seeking: ['WOMAN'], ageRange: { min: 28, max: 37 } },
    });
    const bIntros = await introductions(b);
    expect(bIntros.waiting.map((w) => w.member.memberId)).toContain(a);
    const json = JSON.stringify([bIntros, await b.m.getMemberProfile(b.session, a)]);
    for (const forbidden of ['PRIVATE-WORDS', 'genderqueer', 'selfDescription', 'SELF_DESCRIBED', 'appearsAs', 'seeking', '"WOMAN"', 'ageRange', 'Karaosmanoğlu']) {
      expect(json).not.toContain(forbidden);
    }
    // Her own settings are hers to read.
    expect(value(await shared.m.getDatingSettings(shared.session)).identity?.selfDescription).toBe('PRIVATE-WORDS genderqueer');
  });
});

describe('member client store', () => {
  it('keeps member data in memory only and never decides a match itself', async () => {
    const ctx = await member();
    const lost: string[] = [];
    const store = createMemberStore({ api: ctx.m, getSession: () => ctx.session, onUnauthorized: (k) => lost.push(k) });
    const intro0 = value(await store.actions.loadIntroductions());
    const first = intro0.waiting[0]!;
    expect(store.getState().profiles[first.member.memberId]?.displayName).toBe('Kerem');
    const res = value(await store.actions.react(first.introductionId, 'LIKE'));
    expect(res.match).toBeNull();
    expect(store.getState().introductions!.waiting.map((w) => w.introductionId)).not.toContain(first.introductionId);
    // Nothing member-related was written to device storage by the client.
    const keys = Object.keys(ctx.storage.dump());
    expect(keys.sort()).toEqual(['velvet.admission.v1', 'velvet.mockServer.v1']);
    const device = JSON.parse(ctx.storage.dump()['velvet.admission.v1']!);
    expect(JSON.stringify(device)).not.toContain('Kerem');
    store.actions.reset();
    expect(store.getState()).toEqual({ me: null, introductions: null, conversations: null, profiles: {} });
    expect(lost).toEqual([]);
  });

  it('saving Dating preferences re-reads introductions and the member', async () => {
    const ctx = await member({ setup: false });
    const store = createMemberStore({ api: ctx.m, getSession: () => ctx.session, onUnauthorized: () => undefined });
    expect(value(await store.actions.loadIntroductions()).state).toBe('DATING_SETUP_REQUIRED');
    value(await store.actions.saveDatingSettings(WOMAN_EVERYONE));
    expect(store.getState().introductions).toBeNull();
    expect(store.getState().me?.dating.setupRequired).toBe(false);
    expect(value(await store.actions.loadIntroductions()).state).toBe('READY');
  });

  it('reports lost access so the lifecycle can be re-read', async () => {
    const ctx = await applicant('MEMBERSHIP_PAYMENT_REQUIRED');
    const lost: string[] = [];
    const store = createMemberStore({ api: ctx.m, getSession: () => ctx.session, onUnauthorized: (k) => lost.push(k) });
    expect((await store.actions.loadMe()).ok).toBe(false);
    expect(lost).toEqual(['membership_required']);
  });
});
