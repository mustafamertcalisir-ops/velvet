import { useState } from 'react';

import { Button } from '@/components/Button';
import { WritingField } from '@/components/WritingField';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { copy } from '@/copy/en';
import { ABOUT_YOU_MAX, LONG_TEXT_MIN, WHAT_YOU_DO_MAX } from '@/domain/admission/stage2';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { extendedTextError } from '@/screens/extendedErrors';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/** EXT-04 "What are you known for?" and EXT-05 "What should we know about you?" */
export function LongAnswerStep({ field }: { field: 'whatYouDo' | 'aboutYou' }) {
  const step = field === 'whatYouDo' ? 'what-you-do' : 'about-you';
  const t = field === 'whatYouDo' ? copy.extended.whatYouDo : copy.extended.aboutYou;
  const max = field === 'whatYouDo' ? WHAT_YOU_DO_MAX : ABOUT_YOU_MAX;
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.extendedDraft[field]);
  const { progress, goNext, goBack } = useExtendedStep(step);
  const [value, setValue] = useState(committed ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const r = field === 'whatYouDo' ? actions.setWhatYouDo(value) : actions.setAboutYou(value);
    if (!r.ok) return setError(extendedTextError(r.error));
    goNext();
  };

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID={`screen-${step}`}
      footer={
        <Button label={copy.common.continue} onPress={submit} disabled={value.trim().length === 0} testID="step-continue" />
      }
    >
      <Question headline={t.headline} supporting={t.supporting}>
        <WritingField
          label={t.label}
          placeholder={t.placeholder}
          note={t.note}
          value={value}
          onChangeText={(v) => {
            setValue(v);
            if (error) setError(null);
          }}
          max={max}
          min={LONG_TEXT_MIN}
          error={error}
          testID={`input-${step}`}
        />
      </Question>
    </ScreenShell>
  );
}
