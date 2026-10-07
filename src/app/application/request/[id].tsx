import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { ChoiceList } from '@/components/ChoiceList';
import { requestTitle } from '@/components/InformationRequestList';
import { Notice } from '@/components/Notice';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { WritingField } from '@/components/WritingField';
import { copy } from '@/copy/en';
import { color, radius, space } from '@/design/tokens';
import {
  UPDATABLE_FIELD_MAX,
  type ApplicantInformationRequest,
  type InformationResponse,
} from '@/domain/admission/informationRequests';
import { LONG_TEXT_MIN, OCCUPATION_MAX, type WorkContextAnswer } from '@/domain/admission/stage2';
import { Guard } from '@/navigation/Guard';
import { pickPhotos, preparePhoto, takeVerificationPhoto } from '@/services/media/preparePhotos';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * MORE_INFORMATION_REQUIRED — one requested item. Reachable only while the
 * application is in that state AND the server lists this request. Each type
 * edits exactly the one thing it names; nothing else in the application can
 * be opened from here. Saving stores the response; "Submit update" on the
 * status screen sends everything together.
 */
export default function RequestRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Guard allow={(s) => s.status === 'MORE_INFORMATION_REQUIRED' && s.informationRequests.some((r) => r.id === id)}>
      <RequestScreen id={id} />
    </Guard>
  );
}

function RequestScreen({ id }: { id: string }) {
  const request = useAdmission((s) => s.informationRequests.find((r) => r.id === id));
  if (!request) return null;
  switch (request.type) {
    case 'REPLACE_PHOTO':
    case 'VERIFY_IDENTITY':
      return <PhotoTask request={request} />;
    case 'UPDATE_INSTAGRAM':
      return <InstagramTask request={request} />;
    case 'CLARIFY_WORK':
      return <WorkTask request={request} />;
    case 'UPDATE_APPLICATION_FIELD':
      return <TextTask request={request} />;
  }
}

const back = () => (router.canGoBack() ? router.back() : router.replace('/application/status'));

function useSave(request: ApplicantInformationRequest) {
  const actions = useAdmissionActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (response: InformationResponse) => {
    setBusy(true);
    setError(null);
    const res = await actions.answerInformationRequest(request.id, response);
    setBusy(false);
    if (res.ok) back();
    else setError(res.error.kind === 'validation' ? copy.request.errors.invalid : copy.request.errors.save);
  };
  return { busy, error, setError, save };
}

// --- Replace a photo / confirm identity -------------------------------------------

function PhotoTask({ request }: { request: ApplicantInformationRequest }) {
  const actions = useAdmissionActions();
  const t = copy.request;
  const verify = request.type === 'VERIFY_IDENTITY';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An identity photo is never sent back by the server (DEC-063): only the
  // device that just took it can show it, from its own local copy.
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const uri = request.response?.kind === 'photo' ? request.response.uri : null;
  const received = request.response?.kind === 'verification_received';
  const answered = Boolean(uri) || received;

  const choose = async () => {
    setError(null);
    const picked = verify ? await takeVerificationPhoto() : await pickPhotos(1);
    const asset = picked?.assets[0];
    if (!asset) return;
    setBusy(true);
    try {
      const prepared = await preparePhoto(asset);
      const res = await actions.answerWithPhoto(request.id, prepared);
      if (!res.ok) setError(t.errors.upload);
      else if (verify) setLocalPreview(prepared.uri);
    } catch {
      setError(t.errors.upload);
    }
    setBusy(false);
  };

  return (
    <ScreenShell
      onBack={back}
      testID="screen-request"
      footer={
        answered ? (
          <>
            <Button label={t.done} onPress={back} testID="request-done" />
            <Button
              variant="quiet"
              label={verify ? t.retakePhoto : t.chooseAnother}
              onPress={choose}
              disabled={busy}
              style={styles.centered}
            />
          </>
        ) : (
          <Button
            label={verify ? t.takePhoto : t.choosePhoto}
            onPress={choose}
            loading={busy}
            testID="request-choose-photo"
          />
        )
      }
    >
      <Question headline={requestTitle(request)} supporting={request.explanation}>
        {verify ? (
          <Text variant="body" tone="secondary" style={styles.guide}>
            {t.verifyGuide}
          </Text>
        ) : null}
        <View style={styles.photos}>
          {request.current?.kind === 'photo' ? (
            <Frame label={t.current} uri={request.current.uri} faded={Boolean(answered)} />
          ) : null}
          {uri ? <Frame label={t.replacement} uri={uri} testID="request-new-photo" /> : null}
          {received && localPreview ? <Frame label="" uri={localPreview} testID="request-new-photo" /> : null}
        </View>
        {received ? (
          <Text variant="supporting" tone="secondary" style={styles.guide} testID="request-verification-received">
            {t.verificationReceived}
          </Text>
        ) : null}
        <Notice message={error} testID="request-error" />
      </Question>
    </ScreenShell>
  );
}

function Frame({ label, uri, faded, testID }: { label: string; uri: string; faded?: boolean; testID?: string }) {
  return (
    <View style={styles.frame} testID={testID}>
      {label ? (
        <Text variant="caption" tone="secondary" style={styles.frameLabel}>
          {label}
        </Text>
      ) : null}
      <Image source={{ uri }} style={[styles.frameImage, faded && styles.faded]} contentFit="cover" />
    </View>
  );
}

// --- Instagram ---------------------------------------------------------------------

function InstagramTask({ request }: { request: ApplicantInformationRequest }) {
  const t = copy.request;
  const initial =
    request.response?.kind === 'instagram'
      ? request.response.handle
      : request.current?.kind === 'instagram'
        ? request.current.handle
        : '';
  const [value, setValue] = useState(initial);
  const { busy, error, setError, save } = useSave(request);
  const submit = () => void save({ type: 'UPDATE_INSTAGRAM', handle: value });
  return (
    <ScreenShell
      onBack={back}
      testID="screen-request"
      footer={<Button label={t.save} onPress={submit} loading={busy} disabled={value.trim().length < 1} testID="request-save" />}
    >
      <Question headline={requestTitle(request)} supporting={request.explanation}>
        <TextField
          label={t.instagramLabel}
          value={value}
          onChangeText={(v) => {
            setValue(v.replace(/^@+/, ''));
            if (error) setError(null);
          }}
          onSubmitEditing={submit}
          error={error}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          keyboardType="url"
          returnKeyType="done"
          maxLength={120}
          leading={
            <Text variant="answer" tone="tertiary" style={styles.at}>
              @
            </Text>
          }
          testID="request-input-instagram"
        />
      </Question>
    </ScreenShell>
  );
}

// --- Work ----------------------------------------------------------------------------

type Kind = WorkContextAnswer['kind'];

function WorkTask({ request }: { request: ApplicantInformationRequest }) {
  const t = copy.request;
  const tw = copy.extended.workContext;
  const source =
    request.response?.kind === 'work'
      ? request.response
      : request.current?.kind === 'work'
        ? request.current
        : { occupation: null, workContext: null };
  const [occupation, setOccupation] = useState(source.occupation ?? '');
  const [kind, setKind] = useState<Kind | null>(source.workContext?.kind ?? null);
  const [name, setName] = useState(source.workContext?.kind === 'organisation' ? source.workContext.name : '');
  const { busy, error, setError, save } = useSave(request);

  const submit = () => {
    if (!kind) return;
    const workContext: WorkContextAnswer =
      kind === 'organisation' ? { kind, name } : kind === 'independent' ? { kind } : { kind: 'not_shared' };
    void save({ type: 'CLARIFY_WORK', occupation, workContext });
  };

  return (
    <ScreenShell
      onBack={back}
      testID="screen-request"
      footer={
        <Button
          label={t.save}
          onPress={submit}
          loading={busy}
          disabled={occupation.trim().length < 2 || !kind || (kind === 'organisation' && name.trim().length < 2)}
          testID="request-save"
        />
      }
    >
      <Question headline={requestTitle(request)} supporting={request.explanation}>
        <TextField
          label={t.occupationLabel}
          value={occupation}
          onChangeText={(v) => {
            setOccupation(v);
            if (error) setError(null);
          }}
          grow
          autoCorrect={false}
          autoCapitalize="sentences"
          maxLength={OCCUPATION_MAX + 10}
          error={error}
          testID="request-input-occupation"
        />
        <Text variant="label" tone="secondary" style={styles.workLabel}>
          {t.workplaceLabel}
        </Text>
        <ChoiceList<Kind>
          choices={[
            { key: 'organisation', label: tw.organisation },
            { key: 'independent', label: tw.independent },
            { key: 'not_shared', label: tw.notShared },
          ]}
          selected={kind ? [kind] : []}
          onToggle={setKind}
          renderExpanded={(k) =>
            k === 'organisation' ? (
              <TextField
                label={tw.organisationName}
                hideLabel
                placeholder={tw.organisationPlaceholder}
                grow
                autoCorrect={false}
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                testID="request-input-organisation"
              />
            ) : null
          }
        />
      </Question>
    </ScreenShell>
  );
}

// --- A written answer ---------------------------------------------------------------

function TextTask({ request }: { request: ApplicantInformationRequest }) {
  const t = copy.request;
  const field = request.target?.kind === 'field' ? request.target.field : 'whatYouDo';
  const initial =
    request.response?.kind === 'text' ? request.response.value : request.current?.kind === 'text' ? (request.current.value ?? '') : '';
  const [value, setValue] = useState(initial);
  const { busy, error, setError, save } = useSave(request);
  const q = field === 'whatYouDo' ? copy.extended.whatYouDo : copy.extended.aboutYou;
  return (
    <ScreenShell
      onBack={back}
      testID="screen-request"
      footer={
        <Button
          label={t.save}
          onPress={() => void save({ type: 'UPDATE_APPLICATION_FIELD', field, value })}
          loading={busy}
          disabled={value.trim().length === 0}
          testID="request-save"
        />
      }
    >
      <Question headline={q.headline} supporting={request.explanation}>
        <WritingField
          label={q.label}
          value={value}
          onChangeText={(v) => {
            setValue(v);
            if (error) setError(null);
          }}
          max={UPDATABLE_FIELD_MAX[field]}
          min={LONG_TEXT_MIN}
          note={q.note}
          error={error}
          testID="request-input-text"
        />
      </Question>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  guide: { maxWidth: 440, marginBottom: space[6] },
  photos: { flexDirection: 'row', gap: space[3] },
  frame: { flex: 1, maxWidth: 220 },
  frameLabel: { marginBottom: space[2] },
  frameImage: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.medium, backgroundColor: color.surface },
  faded: { opacity: 0.45 },
  at: { paddingBottom: space[3], paddingTop: space[2], marginRight: space[1] },
  workLabel: { marginTop: space[8], marginBottom: space[2] },
  centered: { alignSelf: 'center', marginTop: space[1] },
});
