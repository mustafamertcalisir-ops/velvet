import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Reveal } from '@/components/Reveal';
import { ScreenShell } from '@/components/ScreenShell';
import { Sheet } from '@/components/Sheet';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, radius, space } from '@/design/tokens';
import { font } from '@/design/typography';
import type { Stage2Step } from '@/domain/admission/stage2';
import { buildProfilePreview, intentPhrase } from '@/domain/profile/profilePresentation';
import { describeApiError } from '@/navigation/errors';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { extendedStepHref } from '@/navigation/routes';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function ExtendedReviewRoute() {
  const [hold, setHold] = useState(false);
  return (
    <ExtendedStepGuard step="review" hold={hold}>
      <ExtendedReview onHold={setHold} />
    </ExtendedStepGuard>
  );
}

/**
 * EXT-13 — review Stage 2 answers as a composed portrait rather than an admin
 * summary: the photographs (lead photo large), the first name and age, what
 * they do and where — then the written answers as typeset sections on
 * hairlines, each with a quiet Edit. Identity comes from the same whitelist
 * as the profile preview (no surname or date of birth). Submitting sends the
 * application to FINAL_REVIEW, never to approval.
 */
function ExtendedReview({ onHold }: { onHold: (h: boolean) => void }) {
  const actions = useAdmissionActions();
  const status = useAdmission((s) => s.status);
  const ext = useAdmission((s) => s.extendedDraft);
  const summary = useAdmission((s) => s.summary);
  const fallbackFirstName = useAdmission((s) => s.draft.firstName);
  const fallbackCity = useAdmission((s) => s.draft.city?.label ?? null);
  const { goBack } = useExtendedStep('review');
  const t = copy.extended.review;

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumed = useRef(false);
  const locked = status === 'EXTENDED_APPLICATION_SUBMITTED';

  const submit = async () => {
    setConfirming(false);
    setSubmitting(true);
    setError(null);
    onHold(true);
    const res = await actions.submitExtended();
    if (res.ok) {
      router.replace('/application/sent');
      return;
    }
    onHold(false);
    setSubmitting(false);
    setError(res.error.kind === 'network' ? t.failed : describeApiError(res.error));
  };

  useEffect(() => {
    if (locked && !resumed.current) {
      resumed.current = true;
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  const edit = (step: Stage2Step) => {
    if (!locked) router.push(extendedStepHref(step, true));
  };

  const portrait = buildProfilePreview({ summary, fallbackFirstName, fallbackCity, extended: ext });
  const organisation =
    ext.workContext?.kind === 'organisation'
      ? ext.workContext.name
      : ext.workContext?.kind === 'independent'
        ? t.independent
        : null;
  const lead = ext.photos[0];
  const others = ext.photos.slice(1, 3);
  const editable = !locked;

  return (
    <ScreenShell
      onBack={locked ? undefined : goBack}
      testID="screen-extended-review"
      footer={
        locked && !submitting ? (
          <>
            <Button label={copy.common.retry} onPress={submit} testID="extended-retry" />
            <Button
              variant="quiet"
              label={copy.review.editAnswers}
              onPress={() => {
                actions.returnToExtendedDraft();
                setError(null);
              }}
              style={styles.centered}
            />
          </>
        ) : (
          <Button label={t.cta} onPress={() => setConfirming(true)} loading={submitting} testID="extended-submit" />
        )
      }
    >
      <Reveal>
        <Text variant="headline" accessibilityRole="header">
          {t.headline}
        </Text>
        <Text variant="body" tone="secondary" style={styles.supporting}>
          {t.supporting}
        </Text>
      </Reveal>

      {/* The portrait: photographs first, then who they introduce. */}
      <View style={styles.portrait}>
        <View style={styles.photos} accessible accessibilityLabel={t.photosA11y(ext.photos.length)}>
          {lead ? <Image source={{ uri: lead.uri }} style={styles.lead} contentFit="cover" /> : null}
          {others.length ? (
            <View style={styles.side}>
              {others.map((p) => (
                <Image key={p.id} source={{ uri: p.uri }} style={styles.sidePhoto} contentFit="cover" />
              ))}
            </View>
          ) : null}
        </View>
        <View style={styles.photoMeta}>
          <Text variant="numeral" tone="tertiary">
            {t.photoCount(ext.photos.length)}
          </Text>
          {editable ? <EditLink section={t.photos} onPress={() => edit('photos')} /> : null}
        </View>

        <View style={styles.identity}>
          <Text style={styles.name} numberOfLines={2} testID="review-name">
            {portrait.firstName}
            {portrait.age !== null ? <Text variant="title" tone="secondary">{`  ${portrait.age}`}</Text> : null}
          </Text>
          {portrait.occupation ? (
            <Text variant="bodyLarge" style={styles.occupation} testID="review-occupation">
              {portrait.occupation}
            </Text>
          ) : null}
          <Text variant="supporting" tone="secondary" style={styles.where}>
            {[organisation, portrait.cityLabel].filter(Boolean).join(' · ')}
          </Text>
          {editable ? (
            <View style={styles.inlineEdits}>
              <Button variant="quiet" label={t.editOccupation} onPress={() => edit('occupation')} />
              <Button variant="quiet" label={t.editWorkplace} onPress={() => edit('work-context')} />
            </View>
          ) : null}
        </View>
      </View>

      <Section label={t.knownFor} onEdit={editable ? () => edit('what-you-do') : undefined}>
        <Text variant="body">{ext.whatYouDo}</Text>
      </Section>
      <Section label={t.about} note={t.aboutNote} onEdit={editable ? () => edit('about-you') : undefined}>
        <Text variant="body">{ext.aboutYou}</Text>
      </Section>
      <Section label={t.interests} onEdit={editable ? () => edit('interests') : undefined}>
        <Text variant="body">{portrait.interestsLine ? `${portrait.interestsLine}.` : ''}</Text>
      </Section>
      <Section label={t.intent} onEdit={editable ? () => edit('intent') : undefined}>
        <Text variant="body">{sentenceCase(intentPhrase(ext.intents))}</Text>
      </Section>
      {ext.intents.includes('dating') ? (
        /* Private matching data: named, never shown — editable in place (DEC-040). */
        <Section label={t.dating} onEdit={editable ? () => edit('meet') : undefined}>
          <Text variant="body" tone="secondary" testID="review-dating">
            {t.datingValue}
          </Text>
        </Section>
      ) : null}

      {submitting ? <Notice message={t.submitting} tone="info" announce={false} /> : null}
      <Notice message={error} testID="extended-error" />

      <Sheet visible={confirming} onClose={() => setConfirming(false)} title={t.confirmTitle} testID="extended-confirm">
        <Text variant="body" tone="secondary">
          {t.confirmBody}
        </Text>
        <View style={styles.sheetActions}>
          <Button label={t.confirmSubmit} onPress={submit} testID="extended-confirm-submit" />
          <Button variant="quiet" label={t.confirmBack} onPress={() => setConfirming(false)} style={styles.centered} />
        </View>
      </Sheet>
    </ScreenShell>
  );
}

/** "friendship and community" → "Friendship and community." */
function sentenceCase(phrase: string | null): string {
  return phrase ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.` : '';
}

function Section({
  label,
  note,
  onEdit,
  children,
}: {
  label: string;
  note?: string;
  onEdit?: () => void;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="label" tone="secondary" style={styles.flex}>
          {label}
          {note ? <Text variant="caption" tone="tertiary">{`  ·  ${note}`}</Text> : null}
        </Text>
        {onEdit ? <EditLink section={label} onPress={onEdit} /> : null}
      </View>
      {children}
    </View>
  );
}

function EditLink({ section, onPress, style }: { section: string; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <Button
      variant="quiet"
      label={copy.extended.review.edit}
      accessibilityLabel={copy.extended.review.editA11y(section.toLowerCase())}
      onPress={onPress}
      style={style}
    />
  );
}

const styles = StyleSheet.create({
  supporting: { marginTop: space[3], maxWidth: 440 },
  flex: { flex: 1 },
  portrait: { marginTop: space[8] },
  photos: { flexDirection: 'row', gap: space[2] },
  lead: { flex: 1.55, aspectRatio: 3 / 4, borderRadius: radius.medium, backgroundColor: color.surface },
  side: { flex: 1, gap: space[2] },
  sidePhoto: { flex: 1, borderRadius: radius.control, backgroundColor: color.surface },
  photoMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space[1] },
  identity: { marginTop: space[4] },
  name: { fontFamily: font.serif, fontSize: 36, lineHeight: 42, letterSpacing: -0.4, color: color.text },
  occupation: { marginTop: space[2] },
  where: { marginTop: space[1] },
  inlineEdits: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space[6], rowGap: space[2], marginTop: space[3] },
  section: {
    marginTop: space[6],
    paddingTop: space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space[1] },
  sheetActions: { marginTop: space[6], gap: space[3] },
  centered: { alignSelf: 'center', marginTop: space[1] },
});
