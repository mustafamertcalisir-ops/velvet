import { Redirect, router, useLocalSearchParams, type Href } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AgeRangeField } from '@/components/AgeRangeField';
import { Button } from '@/components/Button';
import { ChoiceList } from '@/components/ChoiceList';
import { Notice } from '@/components/Notice';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import { AGE_PREFERENCE_MIN_SPAN, suggestedAgeRange, type AgeRange } from '@/domain/admission/stage2';
import {
  DATING_AGE_BOUNDS,
  DATING_CATEGORIES,
  DATING_GENDERS,
  SELF_DESCRIPTION_MAX,
  isEveryone,
  orderedCategories,
  type DatingGenderId,
  type DatingGenderPreference,
} from '@/domain/member/dating';
import type { OwnDatingSettings } from '@/services/api/memberTypes';
import { useMember, useMemberActions } from '@/state/member/MemberProvider';
import { useMemberQuery } from '@/state/member/useMemberQuery';

/**
 * Dating setup (after activation, only for members using Dating) and the
 * same questions when editing Dating preferences later (`?mode=edit`).
 *
 *   1. How do you describe yourself?  Woman · Man · Non-binary · Self-describe
 *      (self-described: private words + the categories to be included under)
 *   2. Who would you like to meet? + age range (pre-filled from the application)
 *
 * Private matching data (DEC-058): never shown on any profile or to anyone
 * else, never inferred. The server validates and stores it.
 */
export default function DatingSetupRoute() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const actions = useMemberActions();
  const me = useMember((s) => s.me);
  const settings = useMemberQuery(() => actions.loadDatingSettings(), 'dating-settings');
  if (me && !me.dating.usesDating) return <Redirect href="/member" />;
  if (!settings.value) return <ScreenShell testID="screen-dating-setup">{null}</ScreenShell>;
  return <DatingSetup initial={settings.value} edit={mode === 'edit'} age={me?.profile.age ?? null} />;
}

type SeekKey = `seek_${DatingGenderPreference}` | 'seek_EVERYONE';
type AppearsKey = `appears_${DatingGenderPreference}`;

function DatingSetup({ initial, edit, age }: { initial: OwnDatingSettings; edit: boolean; age: number | null }) {
  const actions = useMemberActions();
  const t = copy.member.dating;
  const [step, setStep] = useState<1 | 2>(1);
  const [gender, setGender] = useState<DatingGenderId | null>(initial.identity?.gender ?? null);
  const [selfDescription, setSelfDescription] = useState(initial.identity?.selfDescription ?? '');
  const [appearsAs, setAppearsAs] = useState<DatingGenderPreference[]>(
    initial.identity?.gender === 'SELF_DESCRIBED' ? initial.identity.appearsAs : [],
  );
  const [seeking, setSeeking] = useState<DatingGenderPreference[]>(initial.seeking);
  const [range, setRange] = useState<AgeRange>(initial.ageRange ?? suggestedAgeRange(age));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  const selfText = selfDescription.trim();
  const identityReady =
    gender !== null &&
    (gender !== 'SELF_DESCRIBED' || (selfText.length > 0 && selfText.length <= SELF_DESCRIPTION_MAX && appearsAs.length > 0));

  const toggleSeeking = (key: SeekKey) => {
    if (key === 'seek_EVERYONE') {
      setSeeking((cur) => (isEveryone(cur) ? [] : [...DATING_CATEGORIES]));
      return;
    }
    const c = key.slice(5) as DatingGenderPreference;
    setSeeking((cur) => orderedCategories(cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
  };
  const seekingKeys: SeekKey[] = isEveryone(seeking)
    ? ['seek_EVERYONE', ...DATING_CATEGORIES.map((c) => `seek_${c}` as SeekKey)]
    : seeking.map((c) => `seek_${c}` as SeekKey);

  const save = async () => {
    if (!gender) return;
    setSaving(true);
    setErrors([]);
    setFailed(false);
    const res = await actions.saveDatingSettings({
      gender,
      selfDescription: gender === 'SELF_DESCRIBED' ? selfText : null,
      appearsAs: gender === 'SELF_DESCRIBED' ? appearsAs : undefined,
      seeking,
      ageRange: range,
    });
    setSaving(false);
    if (res.ok) {
      if (edit) router.back();
      else router.replace('/member/confirm' as Href);
      return;
    }
    if (res.error.kind === 'validation') {
      setErrors(res.error.fields);
      if (res.error.fields.some((f) => f === 'gender' || f === 'selfDescription' || f === 'appearsAs')) setStep(1);
    } else setFailed(true);
  };

  const fieldError = (f: string) => (errors.includes(f) ? (t.errors[f] ?? null) : null);

  if (step === 1) {
    return (
      <ScreenShell
        key="identity"
        onBack={() => router.back()}
        progress={edit ? undefined : { index: 0, total: 2 }}
        testID="screen-dating-setup"
        footer={<Button label={copy.common.continue} onPress={() => setStep(2)} disabled={!identityReady} testID="dating-continue" />}
      >
        <Question headline={t.identityHeadline} supporting={t.identitySupporting}>
          <ChoiceList<DatingGenderId>
            choices={DATING_GENDERS.map((g) => ({ key: g, label: t.genders[g] ?? g }))}
            selected={gender ? [gender] : []}
            onToggle={(g) => setGender(g)}
            renderExpanded={(g) =>
              g === 'SELF_DESCRIBED' ? (
                <View style={styles.self}>
                  <TextField
                    label={t.selfLabel}
                    size="title"
                    value={selfDescription}
                    onChangeText={setSelfDescription}
                    maxLength={SELF_DESCRIPTION_MAX + 10}
                    hint={t.selfHint}
                    caption={t.selfHint}
                    error={selfText.length > SELF_DESCRIPTION_MAX ? t.errors.selfDescription : fieldError('selfDescription')}
                    autoCapitalize="sentences"
                    testID="dating-self-description"
                  />
                  <Text variant="label" tone="secondary" style={styles.appearsLabel}>
                    {t.appearsLabel}
                  </Text>
                  <Text variant="caption" tone="tertiary" style={styles.appearsHint}>
                    {t.appearsHint}
                  </Text>
                  <ChoiceList<AppearsKey>
                    multiple
                    choices={DATING_CATEGORIES.map((c) => ({ key: `appears_${c}` as AppearsKey, label: t.categories[c] ?? c }))}
                    selected={appearsAs.map((c) => `appears_${c}` as AppearsKey)}
                    onToggle={(k) => {
                      const c = k.slice(8) as DatingGenderPreference;
                      setAppearsAs((cur) => orderedCategories(cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
                    }}
                    testID="dating-appears-as"
                  />
                  {fieldError('appearsAs') ? <Notice message={fieldError('appearsAs')} /> : null}
                </View>
              ) : null
            }
            testID="dating-gender"
          />
          {fieldError('gender') ? <Notice message={fieldError('gender')} /> : null}
        </Question>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell
      key="seeking"
      onBack={() => setStep(1)}
      progress={edit ? undefined : { index: 1, total: 2 }}
      testID="screen-dating-seeking"
      footer={
        <View style={styles.footer}>
          <Notice message={failed ? t.failed : null} />
          <Button
            label={edit ? t.save : t.continue}
            onPress={() => void save()}
            loading={saving}
            disabled={seeking.length === 0}
            testID="dating-save"
          />
        </View>
      }
    >
      <Question headline={t.seekingHeadline} supporting={edit ? t.seekingEditSupporting : t.seekingSupporting}>
        <ChoiceList<SeekKey>
          multiple
          choices={[
            ...DATING_CATEGORIES.map((c) => ({ key: `seek_${c}` as SeekKey, label: t.categories[c] ?? c })),
            { key: 'seek_EVERYONE' as SeekKey, label: t.categories.EVERYONE ?? 'Everyone' },
          ]}
          selected={seekingKeys}
          onToggle={toggleSeeking}
          testID="dating-seeking"
        />
        {fieldError('seeking') ? <Notice message={fieldError('seeking')} /> : null}
        <Text variant="label" tone="secondary" style={styles.ageLabel}>
          {t.ageLabel}
        </Text>
        <AgeRangeField
          value={range}
          onChange={setRange}
          bounds={DATING_AGE_BOUNDS}
          minSpan={AGE_PREFERENCE_MIN_SPAN}
          testID="dating-age-range"
        />
        {fieldError('ageRange') ? <Notice message={fieldError('ageRange')} /> : null}
      </Question>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  self: { gap: space[2] },
  appearsLabel: { marginTop: space[5] },
  appearsHint: { marginBottom: space[2] },
  ageLabel: { marginTop: space[8], marginBottom: space[3] },
  footer: { gap: space[2] },
});
