import { router } from 'expo-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Reveal } from '@/components/Reveal';
import { ScreenShell } from '@/components/ScreenShell';
import { Sheet } from '@/components/Sheet';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { formatE164ForOwner } from '@/domain/validation/phone';
import { describeApiError } from '@/navigation/errors';
import { stepHref } from '@/navigation/routes';
import { StepGuard } from '@/navigation/StepGuard';
import { useStep } from '@/navigation/useStep';
import { composeLetter } from '@/screens/applicationLetter';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function ReviewRoute() {
  // Hold the guard while this screen navigates to "Application received".
  const [hold, setHold] = useState(false);
  return (
    <StepGuard step="review" hold={hold}>
      <ReviewScreen onHold={setHold} />
    </StepGuard>
  );
}

/**
 * APP-08 Review. The answers are read back as a short composed summary in
 * the editorial serif — the one place in Stage 1 where the serif carries
 * body text. Each answer is an underlined, tappable segment; paragraphs that
 * hold private details carry a plain sans note saying so.
 */
function ReviewScreen({ onHold }: { onHold: (h: boolean) => void }) {
  const actions = useAdmissionActions();
  const status = useAdmission((s) => s.status);
  const draft = useAdmission((s) => s.draft);
  const phone = useAdmission((s) => s.account?.phoneE164 ?? null);
  const { goBack } = useStep('review');

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumed = useRef(false);

  const locked = status === 'APPLICATION_SUBMITTED';

  const submit = async () => {
    setConfirming(false);
    setSubmitting(true);
    setError(null);
    onHold(true);
    const res = await actions.submit();
    if (res.ok) {
      router.replace('/application/received');
      return;
    }
    onHold(false);
    setSubmitting(false);
    setError(res.error.kind === 'network' ? copy.review.failed : describeApiError(res.error));
  };

  // Restarted mid-submission: resume the same submission automatically.
  useEffect(() => {
    if (locked && !resumed.current) {
      resumed.current = true;
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  const edit = (step: Parameters<typeof stepHref>[0]) => {
    if (!locked) router.push(stepHref(step, true));
  };

  const letter = composeLetter(draft, copy.review.readback);

  return (
    <ScreenShell
      onBack={locked ? undefined : goBack}
      testID="screen-review"
      footer={
        locked && !submitting ? (
          <>
            <Button label={copy.common.retry} onPress={submit} testID="review-retry" />
            <Button
              variant="quiet"
              label={copy.review.editAnswers}
              onPress={() => {
                actions.returnToDraft();
                setError(null);
              }}
              style={styles.centered}
              testID="review-edit"
            />
          </>
        ) : (
          <Button
            label={copy.review.submit}
            onPress={() => setConfirming(true)}
            loading={submitting}
            testID="review-submit"
          />
        )
      }
    >
      <Reveal>
        <Text variant="headline" accessibilityRole="header">
          {copy.review.headline}
        </Text>
        <Text variant="body" tone="secondary" style={styles.supporting}>
          {copy.review.supporting}
        </Text>
      </Reveal>

      <View style={styles.letter}>
        {letter.map((paragraph) => (
          <View key={paragraph.id} style={styles.paragraph}>
            <Text variant="readback" testID={`letter-${paragraph.id}`}>
              {paragraph.segments.map((seg, j) =>
                'edit' in seg ? (
                  <Text
                    key={j}
                    variant="readback"
                    onPress={locked ? undefined : () => edit(seg.edit)}
                    accessibilityRole="link"
                    accessibilityHint={`Edit ${seg.label.toLowerCase()}`}
                    style={styles.answer}
                    testID={`edit-${seg.edit}`}
                  >
                    {seg.text}
                  </Text>
                ) : (
                  <Fragment key={j}>{seg.text}</Fragment>
                ),
              )}
            </Text>
            {paragraph.privateNote ? (
              <Text variant="caption" tone="tertiary" style={styles.note}>
                {paragraph.privateNote}
              </Text>
            ) : null}
          </View>
        ))}
      </View>

      {phone ? (
        <View style={styles.phone}>
          <Text variant="supporting" tone="secondary">
            {copy.review.verifiedPhone(formatE164ForOwner(phone))}
          </Text>
          <Text variant="caption" tone="tertiary" style={styles.note}>
            {copy.review.privacy}
          </Text>
        </View>
      ) : null}

      {submitting ? <Notice message={copy.review.submitting} tone="info" announce={false} /> : null}
      <Notice message={error} testID="review-error" />

      <Sheet visible={confirming} onClose={() => setConfirming(false)} title={copy.review.confirmTitle} testID="confirm-sheet">
        <Text variant="body" tone="secondary" style={styles.sheetBody}>
          {copy.review.confirmBody}
        </Text>
        <View style={styles.sheetActions}>
          <Button label={copy.review.confirmSubmit} onPress={submit} testID="confirm-submit" />
          <Button
            variant="quiet"
            label={copy.review.confirmBack}
            onPress={() => setConfirming(false)}
            style={styles.centered}
            testID="confirm-back"
          />
        </View>
      </Sheet>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  supporting: { marginTop: space[3], maxWidth: 440 },
  letter: { marginTop: space[8], gap: space[5] },
  paragraph: {},
  answer: {
    color: color.text,
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
    textDecorationColor: color.smoke,
  },
  note: { marginTop: space[1] },
  phone: {
    marginTop: space[8],
    paddingTop: space[4],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  sheetBody: { maxWidth: 440 },
  sheetActions: { marginTop: space[6], gap: space[3] },
  centered: { alignSelf: 'center', marginTop: space[1] },
});
