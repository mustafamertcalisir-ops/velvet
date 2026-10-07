import type { ReactNode } from 'react';

import { canOpenStep, type Stage1Step } from '@/domain/admission/stage1';
import { todayInLocalCalendar } from '@/domain/validation/dateOfBirth';
import { Guard } from './Guard';

/**
 * A Stage 1 step is reachable only while the draft is open and every earlier
 * step is answered — deep links cannot skip questions or reopen a submitted
 * application.
 */
export function StepGuard({ step, hold, children }: { step: Stage1Step; hold?: boolean; children: ReactNode }) {
  return (
    <Guard
      hold={hold}
      allow={(s) =>
        (s.status === 'APPLICATION_DRAFT' && canOpenStep(s.draft, step, todayInLocalCalendar())) ||
        (step === 'review' && s.status === 'APPLICATION_SUBMITTED')
      }
    >
      {children}
    </Guard>
  );
}
