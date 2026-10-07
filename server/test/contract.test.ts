/**
 * Contract: the APP's own code — its HTTP adapters and its admission and
 * member stores — against the real API and PostgreSQL. If the client and
 * server disagree about a path, a payload or an error, this fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATING_CATEGORIES } from '@/domain/member/dating';
import { createHttpAdmissionApi } from '@/services/http/httpAdmissionApi';
import { createHttpClient } from '@/services/http/httpClient';
import { createHttpMemberApi } from '@/services/http/httpMemberApi';
import type { KeyValueStorage } from '@/services/storage';
import { createAdmissionStore } from '@/state/admission/store';
import { createMemberStore } from '@/state/member/memberStore';
import { activeMember, jpegWithExif, nextPhone, review, seedPlan, testServer, type T } from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer();
});
afterAll(async () => t.close());

function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => void m.delete(k),
  } as KeyValueStorage;
}

function client() {
  const call = createHttpClient({
    baseUrl: 'https://api.test',
    fetch: ((url: string, init: RequestInit) => t.app.request(url, init)) as unknown as typeof fetch,
  });
  return { api: createHttpAdmissionApi(call), member: createHttpMemberApi(call) };
}

describe('the app against the production API', () => {
  it('admission: phone → Stage 1 → status → extended application → final review → approval → activation', async () => {
    const { api } = client();
    const store = createAdmissionStore({ api, storage: memoryStorage(), now: () => t.clock.now() });
    const a = store.actions;
    await a.hydrate();
    const phone = nextPhone();
    expect((await a.requestOtp(phone)).ok).toBe(true);
    expect((await a.verifyOtp('000000')).ok).toBe(t.sms.last(phone) === '000000');
    const verified = await a.verifyOtp(t.sms.last(phone)!);
    expect(verified).toEqual({ ok: true, value: 'APPLICATION_DRAFT' });
    a.acknowledgeIntro();
    a.setFirstName('Çağla');
    a.setLastName('Öztürk');
    a.setDateOfBirth({ day: '02', month: '11', year: '1995' });
    a.setInstagram('@cagla.ozturk');
    a.setCountry('TR');
    a.setCity({ kind: 'listed', cityId: 'TR-istanbul', label: 'İstanbul', region: null });
    a.setReferral({ kind: 'none' });
    expect(await a.submit()).toEqual({ ok: true, value: 'APPLICATION_RECEIVED' });
    const state = store.getState();
    expect(state.status).toBe('APPLICATION_RECEIVED');
    const applicationId = state.application!.id;

    await review(t, applicationId, { kind: 'START_REVIEW' });
    expect((await a.refresh()).ok && store.getState().status).toBe('UNDER_REVIEW');
    await review(t, applicationId, { kind: 'REQUEST_EXTENDED' });
    await a.refresh();
    expect((await a.beginExtendedApplication()).ok).toBe(true);
    a.acknowledgeExtendedIntro();
    for (let i = 0; i < 3; i++) {
      const res = await a.addPhoto({ uri: `file:///p${i}.jpg`, dataUri: await jpegWithExif(i), width: 60, height: 80 });
      expect(res.ok).toBe(true);
    }
    a.setOccupation('Ceramicist');
    a.setWorkContext({ kind: 'independent' });
    a.setWhatYouDo('Wood-fired stoneware from a small studio in Kuzguncuk, mostly tableware for restaurants.');
    a.setAboutYou('I collect old Anatolian recipes and cook them badly for friends on Sundays.');
    a.setInterests(['Ceramics', 'Cooking', 'Books']);
    a.setIntents(['dating', 'friendship']);
    a.setMeetPreference(['everyone']);
    a.setAgeRange({ min: 27, max: 38 });
    a.markPreviewSeen();
    expect(await a.submitExtended()).toEqual({ ok: true, value: 'FINAL_REVIEW' });

    await seedPlan(t);
    await review(t, applicationId, { kind: 'APPROVE', reason: 'COMMUNITY_FIT' });
    await a.refresh();
    expect(store.getState().status).toBe('APPROVED');
    expect((await a.beginMembership()).ok).toBe(true);
    expect(store.getState().status).toBe('MEMBERSHIP_PAYMENT_REQUIRED');
    // The provider's confirmation reaches the API, never the app.
    expect(a.billingAvailable()).toBe(false);
    const pay = await t.internal('POST', '/internal/billing/payment-confirmed', {
      accountId: store.getState().session!.userId,
      providerEventId: `p_${applicationId}`,
      provider: 'test',
    });
    expect(pay.status).toBe(200);
    await a.refresh();
    expect(store.getState().status).toBe('ACTIVE_MEMBER');
  });

  it('member: Dating setup → introductions → like → mutual match → conversation, through the member store', async () => {
    const other = await activeMember(t, { firstName: 'Deniz', dateOfBirth: '1992-02-11', dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 25, max: 40 } } });
    const me = await activeMember(t, { firstName: 'Şebnem' });
    const { member } = client();
    const lost: string[] = [];
    const store = createMemberStore({ api: member, getSession: () => ({ token: me.token, userId: me.accountId }), onUnauthorized: (k) => lost.push(k) });
    const s = store.actions;
    expect((await s.loadMe()).ok && store.getState().me?.dating).toEqual({ usesDating: true, setupRequired: true });
    expect((await s.loadIntroductions()).ok && store.getState().introductions?.state).toBe('DATING_SETUP_REQUIRED');
    const saved = await s.saveDatingSettings({ gender: 'WOMAN', seeking: [...DATING_CATEGORIES], ageRange: { min: 28, max: 37 } });
    expect(saved.ok).toBe(true);
    expect(store.getState().me?.dating.setupRequired).toBe(false);
    // He likes her first (through the API), then she likes him back through the app.
    const his = await t.request('GET', '/v1/introductions/today', { token: other.token });
    await t.request('POST', `/v1/introductions/${his.body.waiting[0].introductionId}/reaction`, { token: other.token, body: { type: 'LIKE' } });
    const intro = await s.loadIntroductions();
    expect(intro.ok && intro.value.waiting.map((w) => w.member.displayName)).toEqual(['Deniz']);
    const first = intro.ok ? intro.value.waiting[0]! : null;
    const res = await s.react(first!.introductionId, 'LIKE');
    expect(res.ok && res.value.match?.other.displayName).toBe('Deniz');
    // A double tap replays.
    expect((await s.react(first!.introductionId, 'LIKE')).ok).toBe(true);
    const list = await s.loadConversations();
    expect(list.ok && list.value).toHaveLength(1);
    const conv = await s.openConversation(res.ok ? res.value.match!.matchId : '');
    expect(conv.ok).toBe(true);
    const sent = await s.sendMessage(conv.ok ? conv.value.conversationId : '', 'Merhaba Deniz', s.newMessageId());
    expect(sent.ok && sent.value.body).toBe('Merhaba Deniz');
    const blocked = await s.block(first!.member.memberId);
    expect(blocked.ok).toBe(true);
    expect((await s.loadConversations()).ok && store.getState().conversations).toEqual([]);
    expect(lost).toEqual([]);
  });

  it('an applicant’s member store reports lost access as membership_required', async () => {
    const { member } = client();
    const otp = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: '+905329990011' } });
    const v = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code: t.sms.last('+905329990011') } });
    const lost: string[] = [];
    const store = createMemberStore({ api: member, getSession: () => v.body.session, onUnauthorized: (k) => lost.push(k) });
    expect(await store.actions.loadMe()).toEqual({ ok: false, error: { kind: 'membership_required' } });
    expect(lost).toEqual(['membership_required']);
  });
});
