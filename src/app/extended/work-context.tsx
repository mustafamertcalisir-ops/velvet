import { useState } from 'react';

import { Button } from '@/components/Button';
import { ChoiceList } from '@/components/ChoiceList';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { TextField } from '@/components/TextField';
import { copy } from '@/copy/en';
import type { WorkContextAnswer } from '@/domain/admission/stage2';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { extendedTextError } from '@/screens/extendedErrors';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * EXT-03 — company / studio / institution, independent, or not shared.
 * Optional, but answered explicitly so the draft never holds an ambiguous blank.
 */
export default function WorkContextRoute() {
  return (
    <ExtendedStepGuard step="work-context">
      <WorkContextScreen />
    </ExtendedStepGuard>
  );
}

type Kind = WorkContextAnswer['kind'];

function WorkContextScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.extendedDraft.workContext);
  const { progress, goNext, goBack } = useExtendedStep('work-context');
  const t = copy.extended.workContext;

  const [kind, setKind] = useState<Kind | null>(committed?.kind ?? null);
  const [name, setName] = useState(committed?.kind === 'organisation' ? committed.name : '');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!kind) return;
    const answer: WorkContextAnswer =
      kind === 'organisation' ? { kind, name } : kind === 'independent' ? { kind } : { kind: 'not_shared' };
    const r = actions.setWorkContext(answer);
    if (!r.ok) return setError(extendedTextError(r.error));
    goNext();
  };

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-work-context"
      footer={
        <Button
          label={copy.common.continue}
          onPress={submit}
          disabled={!kind || (kind === 'organisation' && name.trim().length < 2)}
          testID="step-continue"
        />
      }
    >
      <Question headline={t.headline} supporting={t.supporting}>
        <ChoiceList<Kind>
          choices={[
            { key: 'organisation', label: t.organisation },
            { key: 'independent', label: t.independent },
            { key: 'not_shared', label: t.notShared },
          ]}
          selected={kind ? [kind] : []}
          onToggle={(k) => {
            setKind(k);
            setError(null);
          }}
          renderExpanded={(k) =>
            k === 'organisation' ? (
              <TextField
                label={t.organisationName}
                hideLabel
                placeholder={t.organisationPlaceholder}
                grow
                autoCorrect={false}
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  if (error) setError(null);
                }}
                error={error}
                autoFocus={committed?.kind !== 'organisation'}
                autoCapitalize="words"
                autoComplete="organization"
                returnKeyType="done"
                onSubmitEditing={submit}
                testID="input-organisation"
              />
            ) : null
          }
          testID="work-context-choices"
        />
      </Question>
    </ScreenShell>
  );
}
