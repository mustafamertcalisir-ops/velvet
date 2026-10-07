/**
 * Domain models. Kept deliberately separate — see docs/DATA_MODEL.md §14:
 *
 *   UserAccount            — authentication identity (private)
 *   MembershipApplication  — lifecycle record (status + timestamps)
 *   PrivateApplicationData — what the applicant told us (private, review-only)
 *   PublicMemberProfile    — what members may see, created only after activation
 *   Membership             — commercial membership record
 *
 * Never collapse these into one "User" object.
 */
import type { InformationRequestType } from './admission/informationRequests';
import type { AgeRange, Intent, MeetOptionId, WorkContextAnswer } from './admission/stage2';
import type { ApplicationStatus } from './admission/status';

export type ISODateTime = string; // 2026-10-03T09:19:19.408Z
export type ISODate = string; // 1994-03-14 (calendar date, no timezone)
export type CountryCode = string; // ISO 3166-1 alpha-2, upper case

// 1. UserAccount ------------------------------------------------------------
export type UserAccount = {
  id: string;
  /** Private. Authentication + trust data. Never public, never searchable. */
  phoneE164: string;
  phoneVerifiedAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  accountStatus: 'active' | 'suspended' | 'deleted';
};

// 3. MembershipApplication --------------------------------------------------
export type MembershipApplication = {
  id: string;
  userId: string;
  status: ApplicationStatus;

  stage1CompletedAt: ISODateTime | null;
  submittedAt: ISODateTime | null;
  reviewStartedAt: ISODateTime | null;
  extendedRequestedAt: ISODateTime | null;
  extendedSubmittedAt: ISODateTime | null;
  finalReviewStartedAt: ISODateTime | null;
  /** Latest APPROVED / WAITLISTED / NOT_ADMITTED decision. Reasons are internal (ApplicationReviewRecord). */
  decisionAt: ISODateTime | null;

  /** MORE_INFORMATION_REQUIRED: when asked, and which review stage resumes once answered. */
  moreInformationRequestedAt: ISODateTime | null;
  moreInformationReturnTo: Extract<ApplicationStatus, 'UNDER_REVIEW' | 'FINAL_REVIEW'> | null;
  /** When the applicant last sent a requested update. */
  informationProvidedAt: ISODateTime | null;
  /** When a waitlisted application was last reopened into review. */
  reopenedAt: ISODateTime | null;

  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

// Stage 1 value objects ----------------------------------------------------

/**
 * Instagram is a required Stage 1 review signal in V1 (DEC-023). It is not a
 * public profile field. Modelled as a tagged value so an alternate presence
 * (website, portfolio…) can be added later without changing call sites.
 */
export type InstagramAnswer = { kind: 'handle'; handle: string };

/** City is either from our list (disambiguated by region) or typed by the applicant. */
export type CityAnswer =
  | { kind: 'listed'; cityId: string; label: string; region: string | null }
  | { kind: 'other'; label: string };

/**
 * A referral the applicant asks for. The applicant supplies the referrer's
 * name and phone; the server contacts them privately. The applicant is never
 * told whether the number belongs to a member (prevents member enumeration).
 */
export type ReferralRequestDraft = {
  id: string;
  name: string;
  phoneE164: string;
};

export type ReferralAnswer =
  | { kind: 'none' }
  | { kind: 'requested'; referrals: ReferralRequestDraft[] };

// 4. PrivateApplicationData -------------------------------------------------
/** Private, review-only. Never sent to member clients. */
export type PrivateApplicationData = {
  applicationId: string;

  firstName: string;
  /** Private by default (DEC-005). */
  lastName: string;
  /** Private. Public surfaces show derived age only. */
  dateOfBirth: ISODate;

  instagram: InstagramAnswer;

  countryCode: CountryCode;
  city: CityAnswer;

  referral: ReferralAnswer;

  // Stage 2 (extended application).
  occupation: string | null;
  /** Display form ("Studio X", "Independent"). */
  workContext: string | null;
  /** The structured answer, kept so a clarification request can show it back. */
  workContextAnswer: WorkContextAnswer | null;
  workDescription: string | null;
  personalResponse: string | null;
  interests: string[];
  intents: string[];
  education: string | null;
  websiteUrl: string | null;
  portfolioUrl: string | null;

  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

/** Exactly the Stage 1 payload the applicant submits. */
export type Stage1Submission = Pick<
  PrivateApplicationData,
  'firstName' | 'lastName' | 'dateOfBirth' | 'instagram' | 'countryCode' | 'city' | 'referral'
>;

// 5. ApplicationMedia --------------------------------------------------------
/** Private application media. Never shown to members; promotion to member media is explicit (later phase). */
export type ApplicationMedia = {
  id: string;
  applicationId: string;
  type: 'photo' | 'video';
  /** 'verification' media confirms identity only — never part of a profile. */
  purpose: 'profile' | 'verification';
  storageKey: string;
  /** Position among profile photos; -1 when not (or no longer) on the profile. */
  order: number;
  moderationStatus: 'pending' | 'approved' | 'rejected';
  /** Uploaded to answer this information request (null for Stage 2 uploads). */
  requestId: string | null;
  /** Replaced through an information request; kept for audit, not shown. */
  retiredAt: ISODateTime | null;
  createdAt: ISODateTime;
};

// 5b. DatingPreferences -------------------------------------------------------
/**
 * Private matching data (DEC-040). Stored apart from PrivateApplicationData
 * and from any profile: readable only by the applicant/member themselves and
 * authorised matching and review systems. Exists only when Dating was chosen.
 */
export type DatingPreferencesRecord = {
  applicationId: string;
  userId: string;
  meet: MeetOptionId[];
  ageRange: AgeRange;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

// 7. ApplicationReviewRecord (internal) ----------------------------------------
/** One reviewer action. Internal only: never sent to applicant clients. */
export type ApplicationReviewRecord = {
  id: string;
  applicationId: string;
  reviewerId: string;
  action: string;
  fromStatus: ApplicationStatus;
  toStatus: ApplicationStatus;
  reasonCode: string | null;
  requestTypes: InformationRequestType[];
  createdAt: ISODateTime;
};

/**
 * What the server tells the applicant about themselves for display —
 * derived server-side so the device never needs the full date of birth again.
 */
export type ApplicantSummary = {
  firstName: string;
  age: number;
  cityLabel: string | null;
};

// 6. Referral (server record) ----------------------------------------------
export type Referral = {
  id: string;
  applicationId: string;
  applicantUserId: string;
  referrerMemberId: string;
  status: 'requested' | 'confirmed' | 'declined' | 'expired';
  requestedAt: ISODateTime;
  respondedAt: ISODateTime | null;
};

// 8. PublicMemberProfile ----------------------------------------------------
/**
 * Created only for activated members. Contains NO private application fields:
 * no last name, no DOB, no phone, no Instagram, no referral.
 * See src/domain/profile/publicProfile.ts for the only sanctioned constructor.
 */
export type PublicMemberProfile = {
  id: string;
  userId: string;

  displayName: string;
  age: number;
  occupation: string | null;
  cityLabel: string | null;

  bio: string | null;
  /** "Known for" — from the approved application's work description; editable by the member. */
  knownFor: string | null;
  interests: string[];
  /** Shown as one sentence ("Here for friendship and community"), never as tags. */
  intents: Intent[];

  visibility: 'visible' | 'paused' | 'hidden';
  /** When the member confirmed their profile after activation (null until then). */
  confirmedAt: ISODateTime | null;

  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

/**
 * 9. MemberProfileMedia — a member's profile photographs. Promoted explicitly
 * from approved application photos at activation (never verification photos),
 * then owned by the member. Separate from ApplicationMedia.
 */
export type MemberProfileMedia = {
  id: string;
  memberProfileId: string;
  type: 'photo' | 'video';
  storageKey: string;
  order: number;
  width: number | null;
  height: number | null;
  /** The application photo this was promoted from; null for photos added as a member. */
  sourceApplicationMediaId: string | null;
  createdAt: ISODateTime;
};

// 10. Membership ------------------------------------------------------------
export type Membership = {
  id: string;
  userId: string;
  planId: string;
  status: 'pending' | 'active' | 'grace_period' | 'cancelled' | 'expired';
  startedAt: ISODateTime | null;
  renewsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  /**
   * How the membership is (to be) activated: confirmed by a billing provider,
   * or an invited membership started by the membership team (DEC-088) — never
   * a payment, never renewed.
   */
  activation: 'billing' | 'complimentary';
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

// 11. City ------------------------------------------------------------------
export type City = {
  id: string;
  countryCode: CountryCode;
  name: string;
  /** Used to disambiguate duplicates (e.g. Portland, Oregon / Portland, Maine). */
  region: string | null;
};

export type Country = {
  code: CountryCode;
  name: string; // English display name
  nameTr: string; // Turkish display name — searchable
  callingCode: string; // without "+"
  /** True for the main country of a shared calling code (GB for +44, US for +1). */
  primaryForCallingCode?: boolean;
};
