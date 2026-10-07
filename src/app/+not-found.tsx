import { Redirect } from 'expo-router';

import { useAdmission } from '@/state/admission/AdmissionProvider';
import { homeRoute } from '@/navigation/routes';

/** Unknown links resolve to wherever the lifecycle says the applicant belongs. */
export default function NotFound() {
  const state = useAdmission((s) => s);
  if (!state.hydrated) return null;
  return <Redirect href={homeRoute(state)} />;
}
