import type { ReactNode } from 'react';

import { canOpenStage2Step, type Stage2Step } from '@/domain/admission/stage2';
import { Guard } from './Guard';

/**
 * A Stage 2 step is reachable only while the extended draft is open and every
 * earlier step is answered. Review is also reachable while a submit is in flight.
 */
export function ExtendedStepGuard({
  step,
  hold,
  children,
}: {
  step: Stage2Step;
  hold?: boolean;
  children: ReactNode;
}) {
  return (
    <Guard
      hold={hold}
      allow={(s) =>
        (s.status === 'EXTENDED_APPLICATION_DRAFT' && canOpenStage2Step(s.extendedDraft, step)) ||
        (step === 'review' && s.status === 'EXTENDED_APPLICATION_SUBMITTED')
      }
    >
      {children}
    </Guard>
  );
}
