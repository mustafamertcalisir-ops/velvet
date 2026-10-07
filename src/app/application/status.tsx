import { router, type Href } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApplicationBand, Kicker } from '@/components/ApplicationBand';
import { Button } from '@/components/Button';
import { InformationRequestList, requestAction } from '@/components/InformationRequestList';
import { Notice } from '@/components/Notice';
import { PhotoBackdrop } from '@/components/PhotoBackdrop';
import { Reveal } from '@/components/Reveal';
import { StatusStages } from '@/components/StatusStages';
import { Text } from '@/components/Text';
import { copy, statusCopy } from '@/copy/en';
import { DevReviewPanel } from '@/dev/DevReviewPanel';
import { photography, photographyA11y } from '@/design/photography';
import { color, layout, motion, space } from '@/design/tokens';
import { allAnswered } from '@/domain/admission/informationRequests';
import type { ApplicationStatus } from '@/domain/admission/status';
import { stagesFor } from '@/domain/admission/statusStages';
import { countryByCode } from '@/domain/geo/countries';
import { describeApiError } from '@/navigation/errors';
import { Guard } from '@/navigation/Guard';
import { effectiveZone } from '@/navigation/routes';
import { formatLongDate } from '@/screens/applicationLetter';
import { useStatusAction } from '@/screens/useStatusAction';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function StatusRoute() {
  return (
    <Guard allow={(s) => effectiveZone(s) === 'status'}>
      <StatusScreen />
    </Guard>
  );
}

/** States that are outcomes rather than steps: no stage line, no "next step". */
const OUTCOMES: ReadonlySet<ApplicationStatus> = new Set(['WAITLISTED', 'NOT_ADMITTED']);

function StatusScreen() {
  const status = useAdmission((s) => s.status);
  return status === 'APPROVED' ? <ApprovedWelcome /> : <StatusLetter />;
}

/**
 * STATUS-01…08 — the applicant's durable home, possibly for weeks. One
 * composition for every state, varied only where the moment differs:
 *
 *   photograph band · kicker · headline · one-line explanation
 *   [MORE_INFORMATION_REQUIRED: the requested items + Submit update]
 *   quiet stage sequence (review states only — not for outcomes)
 *   plain facts · the applicant's own summary (private) · quiet links
 *
 * Renders entirely from the lifecycle status. No timers, positions,
 * percentages, probabilities or loops (DEC-043).
 */
function StatusLetter() {
  const insets = useSafeAreaInsets();
  const actions = useAdmissionActions();
  const status = useAdmission((s) => s.status);
  const application = useAdmission((s) => s.application);
  const draft = useAdmission((s) => s.draft);
  const requests = useAdmission((s) => s.informationRequests);
  const primary = useStatusAction(status);

  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** The status the update returned to — the "sent" note shows only while it lasts. */
  const [sentInto, setSentInto] = useState<ApplicationStatus | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    const res = await actions.refresh();
    setRefreshing(false);
    setError(res.ok ? null : describeApiError(res.error));
  };

  const sendUpdate = async () => {
    setSending(true);
    setSendError(null);
    const res = await actions.submitInformationUpdate();
    setSending(false);
    if (res.ok) setSentInto(res.value);
    else setSendError(copy.status.requests.failed);
  };

  const text = statusCopy[status];
  const outcome = OUTCOMES.has(status);
  const moreInfo = status === 'MORE_INFORMATION_REQUIRED';
  const sequence = outcome ? null : stagesFor(status, application);
  const submittedOn = application?.submittedAt ? formatLongDate(application.submittedAt.slice(0, 10)) : null;
  // A requested update belongs to the review it resumed — not to an outcome.
  const inReview = status === 'UNDER_REVIEW' || status === 'FINAL_REVIEW';
  const updateOn =
    inReview && application?.informationProvidedAt ? formatLongDate(application.informationProvidedAt.slice(0, 10)) : null;
  const place = [draft.city?.label, countryByCode(draft.countryCode)?.name].filter(Boolean).join(', ');

  const firstOpen = moreInfo ? (requests.find((r) => r.status === 'open') ?? null) : null;
  const ready = moreInfo && allAnswered(requests);
  const openRequest = (id: string) => router.push(`/application/request/${id}` as Href);

  return (
    <View style={styles.root} testID="screen-status">
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + space[8] }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={color.pearl} />}
      >
        {/* The band scrolls with the page, so text never ends up over bright sky. */}
        <ApplicationBand />

        <View style={styles.body}>
          <Reveal key={status}>
            <Kicker testID="status-kicker">{copy.status.kicker(status)}</Kicker>
            <Text variant="display" accessibilityRole="header" testID="status-headline">
              {text?.headline ?? ''}
            </Text>
            {text?.body ? (
              <Text variant="bodyLarge" style={styles.paragraph} testID="status-body">
                {text.body}
              </Text>
            ) : null}
            {status === 'NOT_ADMITTED' ? (
              <Text variant="body" tone="secondary" style={styles.secondary}>
                {copy.status.notAdmittedSecondary}
              </Text>
            ) : null}
            {sentInto === status ? <Notice message={copy.status.requests.sent} tone="info" testID="update-sent" /> : null}
          </Reveal>

          {moreInfo ? (
            <View style={styles.requests}>
              <InformationRequestList requests={requests} primaryId={firstOpen?.id ?? null} onOpen={openRequest} />
              <View style={styles.primary}>
                {firstOpen ? (
                  <Button label={requestAction(firstOpen)} onPress={() => openRequest(firstOpen.id)} testID="request-primary" />
                ) : (
                  <Button
                    label={copy.status.requests.submit}
                    onPress={sendUpdate}
                    loading={sending}
                    disabled={!ready}
                    testID="request-submit"
                  />
                )}
                {firstOpen && requests.filter((r) => r.status === 'open').length > 1 ? (
                  <Text variant="caption" tone="tertiary" style={styles.caption}>
                    {copy.status.requests.remaining(requests.filter((r) => r.status === 'open').length)}
                  </Text>
                ) : null}
                <Notice message={sendError} testID="request-submit-error" />
              </View>
            </View>
          ) : primary && text?.cta ? (
            <View style={styles.primary}>
              <Button label={text.cta} onPress={primary.run} loading={primary.busy} testID="status-primary" />
              <Notice message={primary.error} />
            </View>
          ) : null}

          {sequence ? (
            <View style={styles.stages}>
              <StatusStages sequence={sequence} />
            </View>
          ) : null}

          <View style={styles.facts}>
            {submittedOn ? (
              <Fact label={copy.status.details.submitted} testID="status-submitted-on">
                {submittedOn}
              </Fact>
            ) : null}
            {status === 'WAITLISTED' ? (
              <Fact label={copy.status.currentStatus} testID="status-current">
                {copy.status.waitlistedValue}
              </Fact>
            ) : null}
            {updateOn ? (
              <Fact label={copy.status.updateReceived} testID="status-update-received">
                {copy.status.updateReceivedValue(updateOn)}
              </Fact>
            ) : null}
            {!outcome && !moreInfo ? (
              <Fact label={copy.status.details.nextStep} testID="status-next-step">
                {text?.nextStep ?? copy.status.nothingNeeded}
              </Fact>
            ) : null}
            {status !== 'NOT_ADMITTED' ? (
              <Fact label={copy.status.details.updates}>{copy.status.details.updatesValue}</Fact>
            ) : null}
          </View>

          <Notice message={error} />

          {draft.firstName ? (
            <View style={styles.summary} testID="status-identity">
              <Text variant="label" tone="secondary">
                {copy.status.yourApplication}
              </Text>
              <Text variant="title" style={styles.summaryName}>
                {[draft.firstName, draft.lastName].filter(Boolean).join(' ')}
              </Text>
              {place ? (
                <Text variant="body" tone="secondary">
                  {place}
                </Text>
              ) : null}
              <Text variant="caption" tone="tertiary" style={styles.onlyYou}>
                {copy.status.onlyYou}
              </Text>
            </View>
          ) : null}

          <View style={styles.links}>
            {status !== 'NOT_ADMITTED' ? (
              <Button
                variant="quiet"
                label={refreshing ? copy.status.refreshing : copy.status.checkForUpdates}
                onPress={refresh}
                disabled={refreshing}
                testID="status-refresh"
              />
            ) : (
              <View />
            )}
            <Button
              variant="quiet"
              label={copy.common.signOut}
              onPress={() => void actions.signOut()}
              testID="status-sign-out"
            />
          </View>

          <DevReviewPanel onChanged={refresh} />
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * APPROVED — "Welcome." The strongest moment in admission, kept restrained:
 * the photograph from the very first screen returns full-bleed (the only
 * change of atmosphere), one serif word, one sentence, the date, one action.
 * No celebration. Approval is not membership: Continue opens activation.
 */
function ApprovedWelcome() {
  const insets = useSafeAreaInsets();
  const decisionAt = useAdmission((s) => s.application?.decisionAt ?? null);
  const primary = useStatusAction('APPROVED');
  const text = statusCopy.APPROVED;
  return (
    <View style={styles.root} testID="screen-approved">
      <PhotoBackdrop source={photography.welcome} accessibilityLabel={photographyA11y.welcome} />
      <View style={[styles.welcome, { paddingBottom: Math.max(insets.bottom, space[4]) + space[2] }]}>
        <Reveal duration={motion.considered}>
          <Kicker testID="status-kicker">{copy.status.kicker('APPROVED')}</Kicker>
          <Text variant="display" style={styles.welcomeWord} accessibilityRole="header" testID="status-headline">
            {text?.headline}
          </Text>
          <Text variant="bodyLarge" style={styles.paragraph} testID="status-body">
            {text?.body}
          </Text>
          {decisionAt ? (
            <Text variant="numeral" tone="tertiary" style={styles.date}>
              {copy.status.approvedOn(formatLongDate(decisionAt.slice(0, 10)))}
            </Text>
          ) : null}
        </Reveal>
        <View style={styles.welcomeAction}>
          <Button label={text?.cta ?? ''} onPress={primary?.run ?? (() => undefined)} loading={primary?.busy} testID="status-primary" />
          <Notice message={primary?.error} />
        </View>
      </View>
    </View>
  );
}

function Fact({ label, children, testID }: { label: string; children: ReactNode; testID?: string }) {
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}: ${String(children)}`} testID={testID}>
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
      <Text variant="body" style={styles.factValue}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  scroll: { flexGrow: 1 },
  body: {
    marginTop: -space[8],
    paddingHorizontal: layout.gutter,
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
  },
  paragraph: { marginTop: space[3], maxWidth: 420 },
  secondary: { marginTop: space[3], maxWidth: 420 },
  requests: { marginTop: space[4] },
  primary: { marginTop: space[6] },
  caption: { marginTop: space[3], textAlign: 'center' },
  stages: { marginTop: space[8] },
  facts: { marginTop: space[6], gap: space[4] },
  fact: {},
  factValue: { marginTop: 2 },
  summary: {
    marginTop: space[10],
    paddingTop: space[5],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  summaryName: { marginTop: space[2] },
  onlyYou: { marginTop: space[2] },
  links: { marginTop: space[8], flexDirection: 'row', justifyContent: 'space-between' },
  welcome: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: layout.gutter,
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
  },
  welcomeWord: { fontSize: 56, lineHeight: 62, letterSpacing: -1 },
  date: { marginTop: space[5] },
  welcomeAction: { marginTop: space[10] },
});
