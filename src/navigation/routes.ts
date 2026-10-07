/**
 * Lifecycle → route. Screens never decide where an applicant "belongs";
 * they ask this module. Guards redirect whenever the status changes.
 */
import type { Href } from 'expo-router';

import { canAccessMemberProduct } from '@/domain/admission/access';
import { resumeStep, type Stage1Step } from '@/domain/admission/stage1';
import { resumeStage2Step, type Stage2Step } from '@/domain/admission/stage2';
import { zoneForStatus, type RouteZone } from '@/domain/admission/status';
import { todayInLocalCalendar } from '@/domain/validation/dateOfBirth';
import type { AdmissionState } from '@/state/admission/store';

type RoutingState = Pick<AdmissionState, 'status' | 'membership' | 'draft'> &
  Partial<Pick<AdmissionState, 'extendedDraft'>>;

/** Zone with member access enforced: ACTIVE_MEMBER without a live membership stays out. */
export function effectiveZone(state: RoutingState): RouteZone {
  const zone = zoneForStatus(state.status);
  if (zone === 'member' && !canAccessMemberProduct(state.status, state.membership)) return 'status';
  return zone;
}

export function stepHref(step: Stage1Step, fromReview = false): Href {
  const path = `/apply/${step}` as const;
  return (fromReview ? `${path}?from=review` : path) as Href;
}

export function extendedStepHref(step: Stage2Step, fromReview = false): Href {
  const path = `/extended/${step}` as const;
  return (fromReview ? `${path}?from=review` : path) as Href;
}

export function homeRoute(state: RoutingState, now: Date = new Date()): Href {
  switch (effectiveZone(state)) {
    case 'auth':
      return state.status === 'PHONE_VERIFICATION' ? '/verify/code' : '/';
    case 'apply':
      return state.status === 'APPLICATION_SUBMITTED'
        ? stepHref('review')
        : stepHref(resumeStep(state.draft, todayInLocalCalendar(now)));
    case 'extended':
      return state.status === 'EXTENDED_APPLICATION_SUBMITTED' || !state.extendedDraft
        ? extendedStepHref('review')
        : extendedStepHref(resumeStage2Step(state.extendedDraft));
    case 'status':
      return '/application/status';
    case 'membership':
      return '/membership';
    case 'member':
      return '/member';
  }
}
