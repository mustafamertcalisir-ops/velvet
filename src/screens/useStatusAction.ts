import { useState } from 'react';

import type { ApplicationStatus } from '@/domain/admission/status';
import { describeApiError } from '@/navigation/errors';
import { useAdmissionActions } from '@/state/admission/AdmissionProvider';
import type { ActionResult } from '@/state/admission/store';

export type StatusAction = { run: () => void; busy: boolean; error: string | null };

/**
 * The single primary action the Status screen offers for a lifecycle state,
 * or null when the applicant has nothing to do.
 *
 * EXTENDED_APPLICATION_REQUIRED → "Continue application": asks the server to
 * open the extended draft. The status then becomes EXTENDED_APPLICATION_DRAFT
 * and the route guard takes the applicant to the first unanswered step.
 *
 * APPROVED → "Continue": asks the server to open membership activation
 * (MEMBERSHIP_PAYMENT_REQUIRED); the guard then shows /membership. Approval
 * itself never activates membership.
 *
 * No hard-coded navigation here: the lifecycle decides where the applicant goes.
 */
export function useStatusAction(status: ApplicationStatus): StatusAction | null {
  const actions = useAdmissionActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (action: () => Promise<ActionResult<ApplicationStatus>>) => () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void action().then((res) => {
      setBusy(false);
      if (!res.ok) setError(describeApiError(res.error));
    });
  };

  if (status === 'APPROVED') return { busy, error, run: start(actions.beginMembership) };
  if (status === 'EXTENDED_APPLICATION_REQUIRED') return { busy, error, run: start(actions.beginExtendedApplication) };
  return null;
}
