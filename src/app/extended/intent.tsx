import { useState } from 'react';

import { Button } from '@/components/Button';
import { ChoiceList } from '@/components/ChoiceList';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { copy } from '@/copy/en';
import { INTENTS, type Intent } from '@/domain/admission/stage2';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/** EXT-07 — why the applicant wants to join. Dating preferences (EXT-08) follow in a later pass. */
export default function IntentRoute() {
  return (
    <ExtendedStepGuard step="intent">
      <IntentScreen />
    </ExtendedStepGuard>
  );
}

function IntentScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.extendedDraft.intents);
  const { progress, goNext, goBack } = useExtendedStep('intent');
  const [selected, setSelected] = useState<Intent[]>(committed);
  const t = copy.extended.intent;

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-intent"
      footer={
        <Button
          label={copy.common.continue}
          onPress={() => {
            if (actions.setIntents(selected).ok) goNext();
          }}
          disabled={selected.length === 0}
          testID="step-continue"
        />
      }
    >
      <Question headline={t.headline} supporting={t.supporting}>
        <ChoiceList<Intent>
          multiple
          choices={INTENTS.map((k) => ({ key: k, label: t.options[k].label, detail: t.options[k].detail }))}
          selected={selected}
          onToggle={(k) => setSelected((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))}
          testID="intent-choices"
        />
      </Question>
    </ScreenShell>
  );
}
