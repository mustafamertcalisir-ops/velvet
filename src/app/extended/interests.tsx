import { useState } from 'react';
import { Button } from '@/components/Button';
import { InterestCurator } from '@/components/InterestCurator';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { copy } from '@/copy/en';
import { INTEREST_GROUPS, INTERESTS_MAX, INTERESTS_MIN } from '@/domain/admission/stage2';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/** EXT-06 — a curated collection, 3 to 8, chosen from five small rooms. */
export default function InterestsRoute() {
  return (
    <ExtendedStepGuard step="interests">
      <InterestsScreen />
    </ExtendedStepGuard>
  );
}

function InterestsScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.extendedDraft.interests);
  const { progress, goNext, goBack } = useExtendedStep('interests');
  const [selected, setSelected] = useState<string[]>(committed);
  const t = copy.extended.interests;

  const toggle = (o: string) =>
    setSelected((cur) => (cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]));

  const submit = () => {
    if (actions.setInterests(selected).ok) goNext();
  };

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-interests"
      footer={
        <Button
          label={copy.common.continue}
          onPress={submit}
          disabled={selected.length < INTERESTS_MIN}
          testID="step-continue"
        />
      }
    >
      <Question headline={t.headline} supporting={t.supporting}>
        <InterestCurator
          groups={INTEREST_GROUPS}
          selected={selected}
          onToggle={toggle}
          min={INTERESTS_MIN}
          max={INTERESTS_MAX}
        />
      </Question>
    </ScreenShell>
  );
}
