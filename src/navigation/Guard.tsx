import { Redirect, useIsFocused } from 'expo-router';
import type { ReactNode } from 'react';

import { useAdmission } from '@/state/admission/AdmissionProvider';
import type { AdmissionState } from '@/state/admission/store';
import { homeRoute } from './routes';

/**
 * Renders children only when the current lifecycle allows this route.
 * Otherwise the FOCUSED screen redirects to wherever the lifecycle says the
 * applicant belongs; screens in the background simply render nothing, so a
 * status change never triggers competing redirects.
 *
 * `hold` lets a screen finish its own navigation after an action it started
 * (e.g. Review → Received after submission) without being redirected mid-way.
 */
export function Guard({
  allow,
  hold = false,
  children,
}: {
  allow: (s: AdmissionState) => boolean;
  hold?: boolean;
  children: ReactNode;
}) {
  const state = useAdmission((s) => s);
  const focused = useIsFocused();

  if (!state.hydrated) return null;
  if (hold || allow(state)) return <>{children}</>;
  return focused ? <Redirect href={homeRoute(state)} /> : null;
}
