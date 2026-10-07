/**
 * Admission store — owns the single authoritative ApplicationStatus on the client.
 *
 * Rules enforced here (not in screens):
 * - Client-initiated status changes go through `transition()`.
 * - Statuses beyond APPLICATION_SUBMITTED are only ever adopted from the server.
 * - Stage 1 fields are writable only in APPLICATION_DRAFT.
 * - Changing country clears a city from another country.
 * - Under-18 dates of birth are never committed.
 * - Submission is idempotent and survives restart (APPLICATION_SUBMITTED + key).
 * - Stage 2 mirrors this: fields writable only in EXTENDED_APPLICATION_DRAFT,
 *   submit is idempotent via EXTENDED_APPLICATION_SUBMITTED + key, and the
 *   server — not the client — moves the application on to FINAL_REVIEW.
 * - After the server holds an answer set, the device keeps only what the
 *   applicant's own screens display (data minimisation).
 * - MORE_INFORMATION_REQUIRED: the applicant answers only the requests the
 *   server lists; each response touches only that request's target, and the
 *   server — not the client — returns the application to review.
 * - Membership is never activated here: billing confirms payment to the
 *   server, and the client refreshes (DEC-047).
 */
import {
  ABOUT_YOU_MAX,
  assembleStage2,
  EMPTY_EXTENDED_DRAFT,
  PHOTO_MAX,
  sanitizeExtendedDraft,
  validateIntents,
  validateInterests,
  validateLongText,
  validateShortText,
  validateWorkContext,
  WHAT_YOU_DO_MAX,
  EMPTY_DATING_PREFERENCES,
  validateAgeRange,
  validateMeet,
  type AgeRange,
  type AgeRangeError,
  type MeetOptionId,
  type ApplicationPhoto,
  type ExtendedDraft,
  type Intent,
  type LongTextError,
  type ShortTextError,
  type WorkContextAnswer,
} from '@/domain/admission/stage2';
import {
  canEditStage1,
  canEditStage2,
  hasSubmittedStage1,
  isApplicationStatus,
  isServerTracked,
  transition,
  type ApplicationStatus,
} from '@/domain/admission/status';
import {
  assembleStage1,
  EMPTY_DRAFT,
  MAX_REFERRALS,
  retainAfterSubmission,
  sanitizeDraft,
  type ApplicationDraft,
} from '@/domain/admission/stage1';
import { countryByCode } from '@/domain/geo/countries';
import type {
  ApplicantSummary,
  CityAnswer,
  Membership,
  MembershipApplication,
  ReferralAnswer,
  UserAccount,
} from '@/domain/models';
import {
  todayInLocalCalendar,
  toISODate,
  validateDateOfBirth,
  type DobError,
  type DobParts,
} from '@/domain/validation/dateOfBirth';
import { normalizeInstagram, type InstagramError } from '@/domain/validation/instagram';
import { validateName, validatePlaceName, type NameError } from '@/domain/validation/name';
import { invalid, valid, type Validation } from '@/domain/validation/result';
import type { ApplicantInformationRequest, InformationResponse } from '@/domain/admission/informationRequests';
import type { MembershipPlan } from '@/domain/membership/plan';
import type { AdmissionApi, ApiError, MyApplication, OtpChallenge, Session } from '@/services/api/types';
import { unavailableBilling, type BillingProvider } from '@/services/billing/billing';
import { createId } from '@/lib/id';
import type { KeyValueStorage } from '@/services/storage';

export const STORAGE_KEY = 'velvet.admission.v1';
const SCHEMA_VERSION = 1;

/** Application metadata without status — status lives only in `status`. */
export type ApplicationMeta = Omit<MembershipApplication, 'status'>;

export type PersistedAdmission = {
  version: typeof SCHEMA_VERSION;
  status: ApplicationStatus;
  session: Session | null;
  account: Pick<UserAccount, 'id' | 'phoneE164' | 'phoneVerifiedAt'> | null;
  otpChallenge: OtpChallenge | null;
  draft: ApplicationDraft;
  application: ApplicationMeta | null;
  membership: Membership | null;
  pendingSubmission: { idempotencyKey: string; startedAt: string } | null;
  /** Server-derived display facts (first name, age, city). Never the DOB itself. */
  summary: ApplicantSummary | null;
  extendedDraft: ExtendedDraft;
  pendingExtendedSubmission: { idempotencyKey: string; startedAt: string } | null;
  /** Open requests while MORE_INFORMATION_REQUIRED (from the server); empty otherwise. */
  informationRequests: ApplicantInformationRequest[];
  pendingInformationUpdate: { idempotencyKey: string; startedAt: string } | null;
};

export type AdmissionState = PersistedAdmission & {
  hydrated: boolean;
  lastSyncedAt: string | null;
  /** In memory only: why this device was just signed out (shown once on the welcome screen). */
  signedOutBecause?: 'account_deleted' | null;
};

const initialPersisted = (): PersistedAdmission => ({
  version: SCHEMA_VERSION,
  status: 'UNAUTHENTICATED',
  session: null,
  account: null,
  otpChallenge: null,
  draft: { ...EMPTY_DRAFT },
  application: null,
  membership: null,
  pendingSubmission: null,
  summary: null,
  extendedDraft: { ...EMPTY_EXTENDED_DRAFT },
  pendingExtendedSubmission: null,
  informationRequests: [],
  pendingInformationUpdate: null,
});

export type ActionError = ApiError | { kind: 'not_allowed' } | { kind: 'incomplete'; missing: string[] };
export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: ActionError };

type Options = {
  api: AdmissionApi;
  storage: KeyValueStorage;
  billing?: BillingProvider;
  now?: () => Date;
};

function splitApplication(app: MembershipApplication): { status: ApplicationStatus; meta: ApplicationMeta } {
  const { status, ...meta } = app;
  return { status, meta };
}

export function createAdmissionStore({ api: rawApi, storage, billing = unavailableBilling, now = () => new Date() }: Options) {
  let state: AdmissionState = { ...initialPersisted(), hydrated: false, lastSyncedAt: null };
  /**
   * Bumped whenever this device is cleared (sign-out, account deletion). A
   * response to a request made BEFORE the clear is answered as `unauthorized`
   * and never adopted: a refresh in flight while the account was deleted must
   * not write the application back onto the device.
   */
  let epoch = 0;
  const api = Object.fromEntries(
    Object.entries(rawApi).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        const started = epoch;
        const result = await (fn as (...a: unknown[]) => Promise<unknown>).apply(rawApi, args);
        return started === epoch ? result : { ok: false, error: { kind: 'unauthorized' } };
      },
    ]),
  ) as unknown as typeof rawApi;
  const listeners = new Set<() => void>();
  let writeChain: Promise<void> = Promise.resolve();
  let inFlightSubmit: Promise<ActionResult<ApplicationStatus>> | null = null;
  let inFlightExtended: Promise<ActionResult<ApplicationStatus>> | null = null;
  let inFlightUpdate: Promise<ActionResult<ApplicationStatus>> | null = null;

  const today = () => todayInLocalCalendar(now());
  const isoNow = () => now().toISOString();

  function persisted(s: AdmissionState): PersistedAdmission {
    return {
      version: s.version,
      status: s.status,
      session: s.session,
      account: s.account,
      otpChallenge: s.otpChallenge,
      draft: s.draft,
      application: s.application,
      membership: s.membership,
      pendingSubmission: s.pendingSubmission,
      summary: s.summary,
      extendedDraft: s.extendedDraft,
      pendingExtendedSubmission: s.pendingExtendedSubmission,
      informationRequests: s.informationRequests,
      pendingInformationUpdate: s.pendingInformationUpdate,
    };
  }

  /** Clear every piece of private data from this device (session reset). */
  async function clearDevice(reason: AdmissionState['signedOutBecause']) {
    epoch++;
    state = { ...initialPersisted(), hydrated: true, lastSyncedAt: null, signedOutBecause: reason };
    await writeChain;
    await storage.removeItem(STORAGE_KEY);
    listeners.forEach((l) => l());
  }

  function set(next: Partial<AdmissionState>) {
    state = { ...state, ...next };
    const snapshot = JSON.stringify(persisted(state));
    writeChain = writeChain.then(() => storage.setItem(STORAGE_KEY, snapshot)).catch(() => undefined);
    listeners.forEach((l) => l());
  }

  function move(to: ApplicationStatus, extra: Partial<AdmissionState> = {}) {
    set({ ...extra, status: transition(state.status, to) });
  }

  /** The server is the authority for every status after submission. */
  function adoptServer(
    app: MembershipApplication | null,
    membership: Membership | null,
    summary: ApplicantSummary | null = state.summary,
    requests: ApplicantInformationRequest[] | null = null,
  ) {
    if (!app) return;
    const { status: serverStatus, meta } = splitApplication(app);
    // A Stage 2 submit in flight is not regressed by a stale read of the draft.
    const keepPending =
      state.status === 'EXTENDED_APPLICATION_SUBMITTED' &&
      serverStatus === 'EXTENDED_APPLICATION_DRAFT' &&
      state.pendingExtendedSubmission !== null;
    const status = keepPending ? state.status : serverStatus;
    const extendedDone = meta.extendedSubmittedAt !== null;
    set({
      status,
      draft: hasSubmittedStage1(status) ? retainAfterSubmission(state.draft) : state.draft,
      // Once Stage 2 is with the server, nothing of it needs to stay on the device.
      extendedDraft: extendedDone ? { ...EMPTY_EXTENDED_DRAFT } : state.extendedDraft,
      pendingExtendedSubmission: extendedDone ? null : state.pendingExtendedSubmission,
      application: meta,
      membership,
      summary,
      pendingSubmission: null,
      // Requests are only kept while they are the applicant's next step.
      informationRequests:
        status === 'MORE_INFORMATION_REQUIRED' ? (requests ?? state.informationRequests) : [],
      pendingInformationUpdate: status === 'MORE_INFORMATION_REQUIRED' ? state.pendingInformationUpdate : null,
      lastSyncedAt: isoNow(),
    });
  }

  function adoptMine(v: MyApplication) {
    adoptServer(v.application, v.membership, v.summary, v.informationRequests ?? []);
  }

  function patchExtended(patch: Partial<ExtendedDraft>): ActionResult {
    if (!canEditStage2(state.status)) return { ok: false, error: { kind: 'not_allowed' } };
    set({ extendedDraft: { ...state.extendedDraft, ...patch, updatedAt: isoNow() } });
    return { ok: true, value: undefined };
  }

  function guardExtended<T, E extends string>(
    v: Validation<T, E>,
    commit: (value: T) => Partial<ExtendedDraft>,
  ): Validation<T, E | 'not_allowed'> {
    if (!v.ok) return v;
    return patchExtended(commit(v.value)).ok ? v : invalid('not_allowed');
  }

  function patchDraft(patch: Partial<ApplicationDraft>): ActionResult {
    if (!canEditStage1(state.status)) return { ok: false, error: { kind: 'not_allowed' } };
    set({ draft: { ...state.draft, ...patch, updatedAt: isoNow() } });
    return { ok: true, value: undefined };
  }

  function guardDraft<T, E extends string>(
    v: Validation<T, E>,
    commit: (value: T) => Partial<ApplicationDraft>,
  ): Validation<T, E | 'not_allowed'> {
    if (!v.ok) return v;
    const r = patchDraft(commit(v.value));
    return r.ok ? v : invalid('not_allowed');
  }

  const actions = {
    async hydrate(): Promise<void> {
      try {
        const raw = await storage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<PersistedAdmission>;
          if (parsed.version === SCHEMA_VERSION && isApplicationStatus(parsed.status)) {
            state = {
              ...initialPersisted(),
              ...parsed,
              draft: sanitizeDraft(parsed.draft),
              extendedDraft: sanitizeExtendedDraft(parsed.extendedDraft),
              hydrated: true,
              lastSyncedAt: null,
            } as AdmissionState;
          }
        }
      } catch {
        // Corrupt snapshot: start clean rather than crash. Server state is
        // recovered on the next sign-in.
      }
      state = { ...state, hydrated: true };
      listeners.forEach((l) => l());
    },

    // --- Phone verification ------------------------------------------------
    async requestOtp(phoneE164: string): Promise<ActionResult<OtpChallenge>> {
      if (state.status !== 'UNAUTHENTICATED' && state.status !== 'PHONE_VERIFICATION') {
        return { ok: false, error: { kind: 'not_allowed' } };
      }
      const res = await api.requestOtp(phoneE164);
      if (!res.ok) return res;
      if (state.status === 'UNAUTHENTICATED') move('PHONE_VERIFICATION', { otpChallenge: res.value });
      else set({ otpChallenge: res.value });
      return res;
    },

    async resendOtp(): Promise<ActionResult<OtpChallenge>> {
      if (state.status !== 'PHONE_VERIFICATION' || !state.otpChallenge) {
        return { ok: false, error: { kind: 'not_allowed' } };
      }
      return actions.requestOtp(state.otpChallenge.phoneE164);
    },

    async verifyOtp(code: string): Promise<ActionResult<ApplicationStatus>> {
      const challenge = state.otpChallenge;
      if (state.status !== 'PHONE_VERIFICATION' || !challenge) {
        return { ok: false, error: { kind: 'not_allowed' } };
      }
      const res = await api.verifyOtp(challenge.challengeId, code);
      if (!res.ok) return res;
      const { session, account, application, membership } = res.value;
      const base: Partial<AdmissionState> = {
        session,
        account: { id: account.id, phoneE164: account.phoneE164, phoneVerifiedAt: account.phoneVerifiedAt },
        otpChallenge: null,
      };
      if (application) {
        // Returning applicant: the server's status is authoritative.
        set(base);
        adoptServer(application, membership);
        void actions.refresh(); // fetch the display summary
      } else {
        move('APPLICATION_DRAFT', base);
      }
      return { ok: true, value: state.status };
    },

    changePhoneNumber(): ActionResult {
      if (state.status !== 'PHONE_VERIFICATION') return { ok: false, error: { kind: 'not_allowed' } };
      move('UNAUTHENTICATED', { otpChallenge: null });
      return { ok: true, value: undefined };
    },

    // --- Stage 1 draft -----------------------------------------------------
    acknowledgeIntro(): ActionResult {
      return patchDraft({ introAcknowledged: true });
    },

    setFirstName(raw: string): Validation<string, NameError | 'not_allowed'> {
      return guardDraft(validateName(raw), (firstName) => ({ firstName }));
    },

    setLastName(raw: string): Validation<string, NameError | 'not_allowed'> {
      return guardDraft(validateName(raw), (lastName) => ({ lastName }));
    },

    setDateOfBirth(parts: DobParts): Validation<string, DobError | 'not_allowed'> {
      const v = validateDateOfBirth(parts, today());
      if (!v.ok) return v;
      return guardDraft(valid(toISODate(v.value)), (dateOfBirth) => ({ dateOfBirth }));
    },

    setInstagram(raw: string): Validation<string, InstagramError | 'not_allowed'> {
      return guardDraft(normalizeInstagram(raw), (handle) => ({ instagram: { kind: 'handle', handle } }));
    },

    setCountry(code: string): Validation<string, 'unknown_country' | 'not_allowed'> {
      if (!countryByCode(code)) return invalid('unknown_country');
      // Invariant: a city always belongs to the selected country.
      const city = state.draft.countryCode === code ? state.draft.city : null;
      return guardDraft(valid(code), (countryCode) => ({ countryCode, city }));
    },

    setCity(answer: CityAnswer): Validation<CityAnswer, 'invalid_city' | 'not_allowed'> {
      const country = state.draft.countryCode;
      if (!country) return invalid('invalid_city');
      if (answer.kind === 'listed' && !answer.cityId.startsWith(`${country}-`)) return invalid('invalid_city');
      const label = validatePlaceName(answer.label);
      if (!label.ok) return invalid('invalid_city');
      const normalized: CityAnswer = { ...answer, label: label.value };
      return guardDraft(valid(normalized), (city) => ({ city }));
    },

    setReferral(answer: ReferralAnswer): Validation<ReferralAnswer, 'invalid_referral' | 'not_allowed'> {
      if (answer.kind === 'requested') {
        const phones = new Set(answer.referrals.map((r) => r.phoneE164));
        if (
          answer.referrals.length > MAX_REFERRALS ||
          phones.size !== answer.referrals.length ||
          (state.account && phones.has(state.account.phoneE164))
        ) {
          return invalid('invalid_referral');
        }
      }
      return guardDraft(valid(answer), (referral) => ({ referral }));
    },

    // --- Submission ----------------------------------------------------------
    /**
     * Submit (or resume submitting) Stage 1. Safe to call repeatedly: concurrent
     * calls share one request and the idempotency key survives restarts.
     */
    submit(): Promise<ActionResult<ApplicationStatus>> {
      if (inFlightSubmit) return inFlightSubmit;
      inFlightSubmit = (async (): Promise<ActionResult<ApplicationStatus>> => {
        const session = state.session;
        if (!session) return { ok: false, error: { kind: 'unauthorized' } };

        if (state.status === 'APPLICATION_DRAFT') {
          const assembled = assembleStage1(state.draft, today());
          if (!assembled.ok) return { ok: false, error: { kind: 'incomplete', missing: assembled.missing } };
          move('APPLICATION_SUBMITTED', {
            pendingSubmission: { idempotencyKey: createId('sub'), startedAt: isoNow() },
          });
        }
        if (state.status !== 'APPLICATION_SUBMITTED' || !state.pendingSubmission) {
          return { ok: false, error: { kind: 'not_allowed' } };
        }
        const assembled = assembleStage1(state.draft, today());
        if (!assembled.ok) {
          move('APPLICATION_DRAFT', { pendingSubmission: null });
          return { ok: false, error: { kind: 'incomplete', missing: assembled.missing } };
        }

        const res = await api.submitStage1(session, state.pendingSubmission.idempotencyKey, assembled.submission);
        if (!res.ok) {
          if (res.error.kind === 'validation') {
            // The server rejected the content: reopen the draft for correction.
            move('APPLICATION_DRAFT', { pendingSubmission: null });
          }
          // Network-type failures stay in APPLICATION_SUBMITTED for retry.
          return res;
        }
        if (res.value.status === 'APPLICATION_SUBMITTED' || res.value.status === 'APPLICATION_DRAFT') {
          return { ok: false, error: { kind: 'network' } };
        }
        adoptServer(res.value, state.membership);
        return { ok: true, value: state.status };
      })().finally(() => {
        inFlightSubmit = null;
      });
      return inFlightSubmit;
    },

    /** After a failed submit, let the applicant edit again. */
    returnToDraft(): ActionResult {
      if (state.status !== 'APPLICATION_SUBMITTED' || inFlightSubmit) {
        return { ok: false, error: { kind: 'not_allowed' } };
      }
      move('APPLICATION_DRAFT', { pendingSubmission: null });
      return { ok: true, value: undefined };
    },

    // --- Status --------------------------------------------------------------
    async refresh(): Promise<ActionResult<ApplicationStatus>> {
      if (!state.session || !isServerTracked(state.status)) {
        return { ok: false, error: { kind: 'not_allowed' } };
      }
      const res = await api.getMyApplication(state.session);
      if (!res.ok) {
        if (res.error.kind === 'unauthorized') await actions.signOut();
        return res;
      }
      adoptMine(res.value);
      return { ok: true, value: state.status };
    },

    // --- Stage 2: extended application ---------------------------------------
    /** EXTENDED_APPLICATION_REQUIRED → EXTENDED_APPLICATION_DRAFT (server-confirmed). */
    async beginExtendedApplication(): Promise<ActionResult<ApplicationStatus>> {
      if (!state.session) return { ok: false, error: { kind: 'unauthorized' } };
      if (state.status === 'EXTENDED_APPLICATION_DRAFT') return { ok: true, value: state.status };
      if (state.status !== 'EXTENDED_APPLICATION_REQUIRED') return { ok: false, error: { kind: 'not_allowed' } };
      const res = await api.startExtendedApplication(state.session);
      if (!res.ok) return res;
      adoptMine(res.value);
      return { ok: true, value: state.status };
    },

    acknowledgeExtendedIntro(): ActionResult {
      return patchExtended({ introAcknowledged: true });
    },

    /** Upload one prepared photo and append it. */
    async addPhoto(photo: {
      uri: string;
      dataUri: string;
      width: number;
      height: number;
    }): Promise<ActionResult<ApplicationPhoto>> {
      if (!state.session) return { ok: false, error: { kind: 'unauthorized' } };
      if (!canEditStage2(state.status)) return { ok: false, error: { kind: 'not_allowed' } };
      if (state.extendedDraft.photos.length >= PHOTO_MAX) return { ok: false, error: { kind: 'not_allowed' } };
      const res = await api.uploadApplicationPhoto(state.session, {
        dataUri: photo.dataUri,
        width: photo.width,
        height: photo.height,
      });
      if (!res.ok) return res;
      const added: ApplicationPhoto = {
        id: res.value.id,
        uri: photo.uri,
        width: photo.width,
        height: photo.height,
        moderationStatus: res.value.moderationStatus,
      };
      // Re-read after the await: the list may have changed meanwhile.
      if (state.extendedDraft.photos.length >= PHOTO_MAX) return { ok: false, error: { kind: 'not_allowed' } };
      const r = patchExtended({ photos: [...state.extendedDraft.photos, added] });
      return r.ok ? { ok: true, value: added } : r;
    },

    removePhoto(id: string): ActionResult {
      return patchExtended({ photos: state.extendedDraft.photos.filter((p) => p.id !== id) });
    },

    /** Move a photo to a new position (0 = leads the profile). */
    movePhoto(id: string, toIndex: number): ActionResult {
      const photos = [...state.extendedDraft.photos];
      const from = photos.findIndex((p) => p.id === id);
      if (from === -1) return { ok: false, error: { kind: 'not_allowed' } };
      const [item] = photos.splice(from, 1);
      if (!item) return { ok: false, error: { kind: 'not_allowed' } };
      photos.splice(Math.max(0, Math.min(toIndex, photos.length)), 0, item);
      return patchExtended({ photos });
    },

    setOccupation(raw: string): Validation<string, ShortTextError | 'not_allowed'> {
      return guardExtended(validateShortText(raw), (occupation) => ({ occupation }));
    },

    setWorkContext(answer: WorkContextAnswer): Validation<WorkContextAnswer, ShortTextError | 'not_allowed'> {
      return guardExtended(validateWorkContext(answer), (workContext) => ({ workContext }));
    },

    setWhatYouDo(raw: string): Validation<string, LongTextError | 'not_allowed'> {
      return guardExtended(validateLongText(raw, WHAT_YOU_DO_MAX), (whatYouDo) => ({ whatYouDo }));
    },

    setAboutYou(raw: string): Validation<string, LongTextError | 'not_allowed'> {
      return guardExtended(validateLongText(raw, ABOUT_YOU_MAX), (aboutYou) => ({ aboutYou }));
    },

    setInterests(list: string[]): Validation<string[], 'too_few' | 'too_many' | 'unknown' | 'not_allowed'> {
      return guardExtended(validateInterests(list), (interests) => ({ interests }));
    },

    setIntents(list: string[]): Validation<Intent[], 'required' | 'unknown' | 'not_allowed'> {
      return guardExtended(validateIntents(list), (intents) => ({
        intents,
        // Dating preferences exist only while Dating is chosen (DEC-040): never keep them otherwise.
        ...(intents.includes('dating') ? {} : { datingPreferences: { ...EMPTY_DATING_PREFERENCES } }),
      }));
    },

    setMeetPreference(list: MeetOptionId[]): Validation<MeetOptionId[], 'required' | 'unknown' | 'conflict' | 'not_allowed'> {
      if (!state.extendedDraft.intents.includes('dating')) return invalid('not_allowed');
      return guardExtended(validateMeet(list), (meet) => ({
        datingPreferences: { ...state.extendedDraft.datingPreferences, meet },
      }));
    },

    setAgeRange(range: AgeRange): Validation<AgeRange, AgeRangeError | 'not_allowed'> {
      if (!state.extendedDraft.intents.includes('dating')) return invalid('not_allowed');
      return guardExtended(validateAgeRange(range), (ageRange) => ({
        datingPreferences: { ...state.extendedDraft.datingPreferences, ageRange },
      }));
    },

    markPreviewSeen(): ActionResult {
      return patchExtended({ previewSeen: true });
    },

    /** Submit (or resume) Stage 2. Same guarantees as Stage 1 submit. */
    submitExtended(): Promise<ActionResult<ApplicationStatus>> {
      if (inFlightExtended) return inFlightExtended;
      inFlightExtended = (async (): Promise<ActionResult<ApplicationStatus>> => {
        const session = state.session;
        if (!session) return { ok: false, error: { kind: 'unauthorized' } };
        if (state.status === 'EXTENDED_APPLICATION_DRAFT') {
          const assembled = assembleStage2(state.extendedDraft);
          if (!assembled.ok) return { ok: false, error: { kind: 'incomplete', missing: assembled.missing } };
          move('EXTENDED_APPLICATION_SUBMITTED', {
            pendingExtendedSubmission: { idempotencyKey: createId('ext'), startedAt: isoNow() },
          });
        }
        if (state.status !== 'EXTENDED_APPLICATION_SUBMITTED' || !state.pendingExtendedSubmission) {
          return { ok: false, error: { kind: 'not_allowed' } };
        }
        const assembled = assembleStage2(state.extendedDraft);
        if (!assembled.ok) {
          move('EXTENDED_APPLICATION_DRAFT', { pendingExtendedSubmission: null });
          return { ok: false, error: { kind: 'incomplete', missing: assembled.missing } };
        }
        const res = await api.submitStage2(
          session,
          state.pendingExtendedSubmission.idempotencyKey,
          assembled.submission,
        );
        if (!res.ok) {
          if (res.error.kind === 'validation') move('EXTENDED_APPLICATION_DRAFT', { pendingExtendedSubmission: null });
          return res;
        }
        if (res.value.extendedSubmittedAt === null) return { ok: false, error: { kind: 'network' } };
        adoptServer(res.value, state.membership);
        return { ok: true, value: state.status };
      })().finally(() => {
        inFlightExtended = null;
      });
      return inFlightExtended;
    },

    returnToExtendedDraft(): ActionResult {
      if (state.status !== 'EXTENDED_APPLICATION_SUBMITTED' || inFlightExtended) {
        return { ok: false, error: { kind: 'not_allowed' } };
      }
      move('EXTENDED_APPLICATION_DRAFT', { pendingExtendedSubmission: null });
      return { ok: true, value: undefined };
    },

    // --- MORE_INFORMATION_REQUIRED ----------------------------------------------
    /** Upload a photo that answers one request (replace a photo / confirm identity), then save it as the response. */
    async answerWithPhoto(
      requestId: string,
      photo: { dataUri: string; width: number; height: number },
    ): Promise<ActionResult<ApplicationStatus>> {
      const session = state.session;
      if (!session) return { ok: false, error: { kind: 'unauthorized' } };
      const request = state.informationRequests.find((r) => r.id === requestId);
      if (state.status !== 'MORE_INFORMATION_REQUIRED' || !request) return { ok: false, error: { kind: 'not_allowed' } };
      if (request.type !== 'REPLACE_PHOTO' && request.type !== 'VERIFY_IDENTITY') {
        return { ok: false, error: { kind: 'not_allowed' } };
      }
      const uploaded = await api.uploadApplicationPhoto(session, photo, {
        requestId,
        mediaClass: request.type === 'VERIFY_IDENTITY' ? 'VERIFICATION_MEDIA' : 'APPLICATION_MEDIA',
      });
      if (!uploaded.ok) return uploaded;
      return actions.answerInformationRequest(requestId, { type: request.type, mediaId: uploaded.value.id });
    },

    /** Save (or change) the response to one request. Validated again by the server. */
    async answerInformationRequest(requestId: string, response: InformationResponse): Promise<ActionResult<ApplicationStatus>> {
      const session = state.session;
      if (!session) return { ok: false, error: { kind: 'unauthorized' } };
      const request = state.informationRequests.find((r) => r.id === requestId);
      if (state.status !== 'MORE_INFORMATION_REQUIRED' || !request || request.type !== response.type) {
        return { ok: false, error: { kind: 'not_allowed' } };
      }
      const res = await api.respondToInformationRequest(session, requestId, response);
      if (!res.ok) return res;
      adoptMine(res.value);
      return { ok: true, value: state.status };
    },

    /** Send every answered request (idempotent, survives restart). The server resumes review. */
    submitInformationUpdate(): Promise<ActionResult<ApplicationStatus>> {
      if (inFlightUpdate) return inFlightUpdate;
      inFlightUpdate = (async (): Promise<ActionResult<ApplicationStatus>> => {
        const session = state.session;
        if (!session) return { ok: false, error: { kind: 'unauthorized' } };
        if (state.status !== 'MORE_INFORMATION_REQUIRED') return { ok: false, error: { kind: 'not_allowed' } };
        const unanswered = state.informationRequests.filter((r) => r.status === 'open');
        if (unanswered.length) return { ok: false, error: { kind: 'incomplete', missing: unanswered.map((r) => r.id) } };
        const pending = state.pendingInformationUpdate ?? { idempotencyKey: createId('upd'), startedAt: isoNow() };
        if (!state.pendingInformationUpdate) set({ pendingInformationUpdate: pending });
        const res = await api.submitInformationUpdate(session, pending.idempotencyKey);
        if (!res.ok) return res;
        adoptMine(res.value);
        return { ok: true, value: state.status };
      })().finally(() => {
        inFlightUpdate = null;
      });
      return inFlightUpdate;
    },

    // --- Approval → membership -------------------------------------------------
    /** APPROVED → MEMBERSHIP_PAYMENT_REQUIRED (server-confirmed). */
    async beginMembership(): Promise<ActionResult<ApplicationStatus>> {
      if (!state.session) return { ok: false, error: { kind: 'unauthorized' } };
      if (state.status === 'MEMBERSHIP_PAYMENT_REQUIRED') return { ok: true, value: state.status };
      if (state.status !== 'APPROVED') return { ok: false, error: { kind: 'not_allowed' } };
      const res = await api.beginMembership(state.session);
      if (!res.ok) return res;
      adoptMine(res.value);
      return { ok: true, value: state.status };
    },

    async loadMembershipPlans(): Promise<ActionResult<MembershipPlan[]>> {
      if (!state.session) return { ok: false, error: { kind: 'unauthorized' } };
      return api.getMembershipPlans(state.session);
    },

    /** Whether a billing provider is available in this build. */
    billingAvailable(): boolean {
      return billing.kind !== 'unavailable';
    },

    /**
     * Hand over to billing. The provider confirms payment to the server; the
     * app only refreshes and adopts whatever the server then says.
     */
    async activateMembership(plan: MembershipPlan): Promise<ActionResult<ApplicationStatus> | { ok: false; error: { kind: 'billing_unavailable' | 'billing_cancelled' | 'billing_failed' } }> {
      const session = state.session;
      if (!session) return { ok: false, error: { kind: 'unauthorized' } };
      if (state.status !== 'MEMBERSHIP_PAYMENT_REQUIRED') return { ok: false, error: { kind: 'not_allowed' } };
      const checkout = await billing.checkout({ userId: session.userId, plan });
      if (!checkout.ok) return { ok: false, error: { kind: `billing_${checkout.reason}` as const } };
      return actions.refresh();
    },

    /**
     * Sign out: revoke this device's session on the server (best effort, a few
     * seconds at most — signing out never waits on a slow network), then clear
     * every piece of private data from this device.
     */
    async signOut(): Promise<void> {
      const session = state.session;
      if (session) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([api.signOut(session).catch(() => undefined), new Promise((r) => (timer = setTimeout(r, 3000)))]);
        clearTimeout(timer);
      }
      // Already signed out (e.g. a late 401 after an account deletion): keep the one-time notice.
      await clearDevice(session ? null : (state.signedOutBecause ?? null));
    },

    /**
     * Delete the account (DEC-077). The server deactivates it at once and signs
     * out every device; only then is this device cleared. If the request
     * fails, nothing changes — the person is still signed in and can retry.
     */
    async deleteAccount(): Promise<ActionResult> {
      const session = state.session;
      if (!session) return { ok: false, error: { kind: 'unauthorized' } };
      const r = await api.requestAccountDeletion(session);
      if (!r.ok) {
        if (r.error.kind === 'unauthorized') await clearDevice(null);
        return { ok: false, error: r.error };
      }
      await clearDevice('account_deleted');
      return { ok: true, value: undefined };
    },

    /** The one-time sign-out notice has been shown. */
    dismissSignedOutNotice() {
      if (!state.signedOutBecause) return;
      state = { ...state, signedOutBecause: null };
      listeners.forEach((l) => l());
    },
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Resolves when all pending persistence writes have flushed (tests, sign-out). */
    flush: () => writeChain,
    actions,
  };
}

export type AdmissionStore = ReturnType<typeof createAdmissionStore>;
export type AdmissionActions = AdmissionStore['actions'];
