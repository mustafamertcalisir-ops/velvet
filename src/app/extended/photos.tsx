import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionSheet, type SheetAction } from '@/components/ActionSheet';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { PhotoCollage } from '@/components/PhotoCollage';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, radius, space } from '@/design/tokens';
import { PHOTO_MAX, PHOTO_MIN, type ApplicationPhoto } from '@/domain/admission/stage2';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { pickPhotos, preparePhoto } from '@/services/media/preparePhotos';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * EXT-01 — photos are the emotional centre of Stage 2. A composed collage in
 * which the first frame is visibly the one that introduces the applicant.
 * 3–6 photos, uploaded as added, reorderable and removable.
 */
export default function PhotosRoute() {
  return (
    <ExtendedStepGuard step="photos">
      <PhotosScreen />
    </ExtendedStepGuard>
  );
}

function PhotosScreen() {
  const actions = useAdmissionActions();
  const photos = useAdmission((s) => s.extendedDraft.photos);
  const { progress, goNext, goBack } = useExtendedStep('photos');
  const t = copy.extended.photos;

  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ photo: ApplicationPhoto; index: number } | null>(null);

  const add = async () => {
    if (uploading > 0 || photos.length >= PHOTO_MAX) return;
    setError(null);
    const picked = await pickPhotos(PHOTO_MAX - photos.length);
    if (!picked) return;
    setUploading(picked.assets.length);
    let failed = false;
    for (const asset of picked.assets) {
      try {
        const prepared = await preparePhoto(asset);
        const res = await actions.addPhoto(prepared);
        if (!res.ok) failed = true;
      } catch {
        setError(t.errors.prepare);
      }
      setUploading((n) => Math.max(0, n - 1));
    }
    if (failed) setError(t.errors.upload);
  };

  const close = () => setSelected(null);
  const act = (fn: () => void) => () => {
    fn();
    close();
  };

  const sheetActions: SheetAction[] = selected
    ? [
        ...(selected.index > 0
          ? [
              { key: 'first', label: t.moveFirst, onPress: act(() => actions.movePhoto(selected.photo.id, 0)), testID: 'photo-move-first' },
              { key: 'earlier', label: t.moveEarlier, onPress: act(() => actions.movePhoto(selected.photo.id, selected.index - 1)) },
            ]
          : []),
        ...(selected.index < photos.length - 1
          ? [{ key: 'later', label: t.moveLater, onPress: act(() => actions.movePhoto(selected.photo.id, selected.index + 1)) }]
          : []),
        { key: 'remove', label: t.remove, destructive: true, onPress: act(() => actions.removePhoto(selected.photo.id)), testID: 'photo-remove' },
      ]
    : [];

  const enough = photos.length >= PHOTO_MIN;

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-photos"
      footer={
        <Button
          label={enough ? copy.common.continue : t.needMore(PHOTO_MIN - photos.length)}
          onPress={goNext}
          disabled={!enough || uploading > 0}
          testID="step-continue"
        />
      }
    >
      <Question headline={t.headline} supporting={t.supporting}>
        <PhotoCollage
          photos={photos}
          max={PHOTO_MAX}
          uploading={uploading}
          onAdd={add}
          onPhotoPress={(photo, index) => setSelected({ photo, index })}
        />
        <View style={styles.meta}>
          <Text variant="supporting" tone="secondary" style={styles.flex}>
            {photos.length === 0 ? t.rule(PHOTO_MIN, PHOTO_MAX) : t.hint}
          </Text>
          <Text variant="numeral" tone="tertiary" testID="photo-count">
            {t.count(photos.length, PHOTO_MAX)}
          </Text>
        </View>
        <Notice message={error} testID="photos-error" />
        {!error ? (
          <Text variant="caption" tone="tertiary" style={styles.review}>
            {t.review}
          </Text>
        ) : null}
      </Question>

      <ActionSheet
        visible={selected !== null}
        onClose={close}
        cancelLabel={t.cancel}
        testID="photo-options"
        actions={sheetActions}
        header={
          selected ? (
            <View style={styles.sheetHeader}>
              <Image source={{ uri: selected.photo.uri }} style={styles.thumb} contentFit="cover" />
              <View style={styles.flex}>
                <Text variant="title">{t.sheetTitle(selected.index + 1, photos.length)}</Text>
                <Text variant="supporting" tone="secondary">
                  {selected.index === 0 ? t.introduces : t.position(selected.index + 1)}
                </Text>
              </View>
            </View>
          ) : null
        }
      />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'flex-start', gap: space[4], marginTop: space[4] },
  flex: { flex: 1 },
  review: { marginTop: space[2] },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  thumb: { width: 48, height: 64, borderRadius: radius.control - 4, backgroundColor: color.surface },
});
