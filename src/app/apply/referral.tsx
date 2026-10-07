import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { PhoneField } from '@/components/PhoneField';
import { Question } from '@/components/Question';
import { ReferralList } from '@/components/ReferralList';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import { MAX_REFERRALS } from '@/domain/admission/stage1';
import { DEFAULT_COUNTRY } from '@/domain/geo/countries';
import type { ReferralRequestDraft } from '@/domain/models';
import { validateName } from '@/domain/validation/name';
import { validatePhone } from '@/domain/validation/phone';
import { createId } from '@/lib/id';
import { StepGuard } from '@/navigation/StepGuard';
import { useStep } from '@/navigation/useStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function ReferralRoute() {
  return (
    <StepGuard step="referral">
      <ReferralScreen />
    </StepGuard>
  );
}

function ReferralScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.draft.referral);
  const ownPhone = useAdmission((s) => s.account?.phoneE164 ?? null);
  const { progress, goNext, goBack } = useStep('referral');

  const [referrals, setReferrals] = useState<ReferralRequestDraft[]>(
    committed?.kind === 'requested' ? committed.referrals : [],
  );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [national, setNational] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const resetForm = () => {
    setName('');
    setNational('');
    setNameError(null);
    setPhoneError(null);
    setAdding(false);
  };

  const add = () => {
    const n = validateName(name);
    const p = validatePhone(national, country);
    setNameError(n.ok ? null : copy.referral.errors.name);
    if (!p.ok) setPhoneError(copy.referral.errors.phone);
    else if (p.value.e164 === ownPhone) setPhoneError(copy.referral.errors.self);
    else if (referrals.some((r) => r.phoneE164 === p.value.e164)) setPhoneError(copy.referral.errors.duplicate);
    else setPhoneError(null);
    if (!n.ok || !p.ok || p.value.e164 === ownPhone || referrals.some((r) => r.phoneE164 === p.value.e164)) return;
    setReferrals([...referrals, { id: createId('ref'), name: n.value, phoneE164: p.value.e164 }]);
    resetForm();
  };

  const continueWithReferrals = () => {
    if (actions.setReferral({ kind: 'requested', referrals }).ok) goNext();
  };

  const continueWithout = () => {
    if (actions.setReferral({ kind: 'none' }).ok) goNext();
  };

  const footer = adding ? (
    <>
      <Button label={copy.referral.save} onPress={add} testID="referral-save" />
      <Button variant="quiet" label={copy.referral.cancel} onPress={resetForm} style={styles.centered} />
    </>
  ) : referrals.length > 0 ? (
    <>
      <Button label={copy.common.continue} onPress={continueWithReferrals} testID="step-continue" />
      {referrals.length < MAX_REFERRALS ? (
        <Button
          variant="quiet"
          label={copy.referral.addAnother}
          onPress={() => setAdding(true)}
          style={styles.centered}
        />
      ) : null}
    </>
  ) : (
    <>
      <Button label={copy.referral.add} onPress={() => setAdding(true)} testID="referral-add" />
      <Button
        variant="secondary"
        label={copy.referral.none}
        onPress={continueWithout}
        testID="referral-none"
      />
    </>
  );

  return (
    <ScreenShell onBack={goBack} progress={progress} footer={footer} testID="screen-referral">
      <Question headline={copy.referral.headline} supporting={copy.referral.supporting}>
        {referrals.length > 0 ? (
          <ReferralList referrals={referrals} onRemove={(id) => setReferrals(referrals.filter((r) => r.id !== id))} />
        ) : null}

        {adding ? (
          <View style={styles.form}>
            <TextField
              label={copy.referral.nameLabel}
              value={name}
              onChangeText={(t) => {
                setName(t);
                setNameError(null);
              }}
              size="title"
              autoFocus
              autoCapitalize="words"
              autoCorrect={false}
              error={nameError}
              testID="referral-name"
            />
            <PhoneField
              label={copy.referral.phoneLabel}
              countryCode={country}
              onCountryChange={setCountry}
              national={national}
              onNationalChange={(v) => {
                setNational(v);
                setPhoneError(null);
              }}
              onSubmit={add}
              error={phoneError}
              testID="referral-phone"
            />
          </View>
        ) : null}

        {!adding && referrals.length === 0 && committed?.kind === 'none' ? (
          <Notice message={copy.referral.noneChosen} tone="info" announce={false} />
        ) : null}

        <Text variant="supporting" tone="secondary" style={styles.explainer}>
          {copy.referral.explainer}
        </Text>
      </Question>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  form: { gap: space[8], marginTop: space[2] },
  explainer: { marginTop: space[8], maxWidth: 420 },
  centered: { alignSelf: 'center', marginTop: space[1] },
});
