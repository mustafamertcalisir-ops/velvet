import { useState } from 'react';

import { Button } from '@/components/Button';
import { ChoiceList } from '@/components/ChoiceList';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { copy } from '@/copy/en';
import { MEET_OPTIONS, toggleMeetOption, type MeetOptionId } from '@/domain/admission/stage2';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * EXT-08a — who the applicant would like to meet. Shown only when Dating was
 * chosen (the guard and the step list skip it otherwise). Private matching
 * data: never on the profile preview, the review portrait or any member surface.
 */
export default function MeetRoute() {
  return (
    <ExtendedStepGuard step="meet">
      <MeetScreen />
    </ExtendedStepGuard>
  );
}

function MeetScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.extendedDraft.datingPreferences.meet);
  const { progress, goNext, goBack } = useExtendedStep('meet');
  const [selected, setSelected] = useState<MeetOptionId[]>(committed);
  const t = copy.extended.meet;

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-meet"
      footer={
        <Button
          label={copy.common.continue}
          onPress={() => {
            if (actions.setMeetPreference(selected).ok) goNext();
          }}
          disabled={selected.length === 0}
          testID="step-continue"
        />
      }
    >
      <Question headline={t.headline} supporting={t.supporting}>
        <ChoiceList<MeetOptionId>
          multiple
          choices={MEET_OPTIONS.map((o) => ({ key: o.id, label: t.options[o.id] ?? o.id }))}
          selected={selected}
          onToggle={(id) => setSelected((cur) => toggleMeetOption(cur, id))}
          testID="meet-choices"
        />
      </Question>
    </ScreenShell>
  );
}
