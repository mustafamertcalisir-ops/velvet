import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { OTP_LENGTH, OtpField } from '@/components/OtpField';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { DEV_FLAGS } from '@/config';
import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import { formatE164ForOwner } from '@/domain/validation/phone';
import { Guard } from '@/navigation/Guard';
import { describeApiError } from '@/navigation/errors';
import { developmentOtpHint } from '@/services';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function CodeRoute() {
  // On success the status leaves PHONE_VERIFICATION and the guard routes onward.
  return (
    <Guard allow={(s) => s.status === 'PHONE_VERIFICATION' && s.otpChallenge !== null}>
      <CodeScreen />
    </Guard>
  );
}

function useSecondsUntil(iso: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000)) : 0;
}

function CodeScreen() {
  const actions = useAdmissionActions();
  const challenge = useAdmission((s) => s.otpChallenge);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [locked, setLocked] = useState(false);

  const resendIn = useSecondsUntil(challenge?.resendAvailableAt);
  const expiresIn = useSecondsUntil(challenge?.expiresAt);
  const expired = Boolean(challenge) && expiresIn === 0;

  const verify = async (value: string) => {
    if (verifying || value.length !== OTP_LENGTH || locked || expired) return;
    setVerifying(true);
    setError(null);
    setInfo(null);
    const res = await actions.verifyOtp(value);
    if (res.ok) {
      // Light confirmation on success (DESIGN.md: haptics for successful verification only).
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      return; // The guard navigates onward; keep the loading state until unmount.
    }
    setVerifying(false);
    setCode('');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    const e = res.error;
    if (e.kind === 'invalid_code') {
      setError(
        e.attemptsRemaining <= 2
          ? `${copy.otp.errors.invalid_code} ${copy.otp.errors.attemptsLeft(e.attemptsRemaining)}`
          : copy.otp.errors.invalid_code,
      );
    } else {
      if (e.kind === 'too_many_attempts' || e.kind === 'code_expired') setLocked(true);
      setError(describeApiError(e));
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    const res = await actions.resendOtp();
    setResending(false);
    if (!res.ok) {
      setError(describeApiError(res.error));
      return;
    }
    setLocked(false);
    setCode('');
    setInfo(copy.otp.resent);
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/verify/phone'));

  if (!challenge) return null;
  const phone = formatE164ForOwner(challenge.phoneE164).replace(/ /g, '\u00A0'); // keep the number on one line
  const blocked = locked || expired;

  return (
    <ScreenShell
      onBack={back}
      testID="screen-code"
      footer={
        <Button
          label={copy.otp.verify}
          onPress={() => verify(code)}
          loading={verifying}
          disabled={code.length !== OTP_LENGTH || blocked}
          testID="code-verify"
        />
      }
    >
      <Question headline={copy.otp.headline} supporting={copy.otp.supporting(phone)}>
        <OtpField
          value={code}
          onChange={(v) => {
            setCode(v);
            if (error && !blocked) setError(null);
          }}
          onComplete={verify}
          error={Boolean(error)}
          disabled={verifying || blocked}
        />
        <Notice
          message={error ?? (expired && !locked ? copy.otp.errors.code_expired : null)}
          testID="code-error"
        />
        <Notice message={!error ? info : null} tone="info" announce={false} />
        <View style={styles.links}>
          <Button
            variant="quiet"
            label={resendIn > 0 ? copy.otp.resendIn(resendIn) : copy.otp.resend}
            onPress={resend}
            disabled={resendIn > 0}
            loading={resending}
            testID="code-resend"
          />
          <Button variant="quiet" label={copy.otp.changeNumber} onPress={back} />
        </View>
        {DEV_FLAGS.panel && developmentOtpHint() ? (
          <Text variant="caption" tone="tertiary" style={styles.dev} testID="otp-dev-hint">
            {copy.otp.devHint(developmentOtpHint() ?? '')}
          </Text>
        ) : null}
      </Question>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  links: { marginTop: space[6], gap: space[1] },
  dev: { marginTop: space[8] },
});
