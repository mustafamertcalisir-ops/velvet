import { router } from 'expo-router';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { PhoneField } from '@/components/PhoneField';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { copy } from '@/copy/en';
import { DEFAULT_COUNTRY } from '@/domain/geo/countries';
import { validatePhone } from '@/domain/validation/phone';
import { Guard } from '@/navigation/Guard';
import { describeApiError } from '@/navigation/errors';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function PhoneRoute() {
  return (
    <Guard allow={(s) => s.status === 'UNAUTHENTICATED' || s.status === 'PHONE_VERIFICATION'}>
      <PhoneScreen />
    </Guard>
  );
}

function PhoneScreen() {
  const actions = useAdmissionActions();
  const existing = useAdmission((s) => s.otpChallenge?.phoneE164 ?? null);
  const parsedExisting = existing ? parsePhoneNumberFromString(existing) : undefined;

  const [countryCode, setCountryCode] = useState<string>(parsedExisting?.country ?? DEFAULT_COUNTRY);
  const [national, setNational] = useState(parsedExisting?.formatNational() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (loading) return;
    const parsed = validatePhone(national, countryCode);
    if (!parsed.ok) {
      setError(copy.phone.errors[parsed.error]);
      return;
    }
    if (parsed.value.countryCode !== countryCode) setCountryCode(parsed.value.countryCode);
    setError(null);
    setLoading(true);
    const res = await actions.requestOtp(parsed.value.e164);
    setLoading(false);
    if (!res.ok) {
      setError(
        res.error.kind === 'rate_limited'
          ? copy.phone.errors.rate_limited(Math.ceil(res.error.retryAfterMs / 1000))
          : res.error.kind === 'invalid_phone'
            ? copy.phone.errors.invalid_number
            : describeApiError(res.error),
      );
      return;
    }
    router.push('/verify/code');
  };

  const back = () => {
    actions.changePhoneNumber(); // no-op unless a code was already requested
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <ScreenShell
      onBack={back}
      testID="screen-phone"
      footer={
        <Button
          label={copy.common.continue}
          onPress={submit}
          loading={loading}
          disabled={national.replace(/\D/g, '').length < 4}
          testID="phone-continue"
        />
      }
    >
      <Question headline={copy.phone.headline} supporting={copy.phone.supporting}>
        <PhoneField
          label={copy.phone.label}
          countryCode={countryCode}
          onCountryChange={(c) => {
            setCountryCode(c);
            setError(null);
          }}
          national={national}
          onNationalChange={(v) => {
            setNational(v);
            if (error) setError(null);
          }}
          onSubmit={submit}
          error={error}
          hint={copy.phone.privacy}
          autoFocus
          testID="phone-input"
        />
      </Question>
    </ScreenShell>
  );
}
