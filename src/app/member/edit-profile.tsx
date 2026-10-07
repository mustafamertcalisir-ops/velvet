import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ActionSheet } from '@/components/ActionSheet';
import { Button } from '@/components/Button';
import { InterestCurator } from '@/components/InterestCurator';
import { Notice } from '@/components/Notice';
import { ScreenShell } from '@/components/ScreenShell';
import { Sheet } from '@/components/Sheet';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { WritingField } from '@/components/WritingField';
import { Photo } from '@/components/member/Photo';
import { copy } from '@/copy/en';
import { color, radius, space } from '@/design/tokens';
import {
  INTEREST_GROUPS,
  INTERESTS_MAX,
  INTERESTS_MIN,
  LONG_TEXT_MIN,
  PHOTO_MAX,
  PHOTO_MIN,
  WHAT_YOU_DO_MAX,
} from '@/domain/admission/stage2';
import { joinNatural } from '@/domain/profile/profilePresentation';
import type { MemberPhoto, MemberProfilePatch, OwnMemberProfile } from '@/domain/member/views';
import { pickPhotos, preparePhoto } from '@/services/media/preparePhotos';
import { useMember, useMemberActions } from '@/state/member/MemberProvider';

/**
 * Edit profile — public member-profile fields only (DEC-049). The approved
 * application, its decision, referral and reviewer data are not reachable
 * from here, and editing never changes them.
 */
export default function EditProfileRoute() {
  const me = useMember((s) => s.me);
  if (!me) return <View style={styles.blank} testID="screen-edit-profile" />;
  return <EditProfile profile={me.profile} />;
}

function EditProfile({ profile }: { profile: OwnMemberProfile }) {
  const actions = useMemberActions();
  const t = copy.member.edit;
  const [order, setOrder] = useState<string[]>(profile.photos.map((p) => p.id));
  const [occupation, setOccupation] = useState(profile.occupation ?? '');
  const [city, setCity] = useState(profile.cityLabel ?? '');
  const [knownFor, setKnownFor] = useState(profile.knownFor ?? '');
  const [interests, setInterests] = useState<string[]>(profile.interests);
  const [choosing, setChoosing] = useState(false);
  const [photoMenu, setPhotoMenu] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const photos = order
    .map((id) => profile.photos.find((p) => p.id === id))
    .filter((p): p is MemberPhoto => Boolean(p));

  const add = async () => {
    const picked = await pickPhotos(1);
    const asset = picked?.assets[0];
    if (!asset) return;
    setUploading(true);
    setMessage(null);
    try {
      const prepared = await preparePhoto(asset);
      const res = await actions.addProfilePhoto({ dataUri: prepared.dataUri, width: prepared.width, height: prepared.height });
      if (res.ok) {
        const known = new Set(order);
        const added = res.value.profile.photos.map((p) => p.id).filter((id) => !known.has(id));
        setOrder((o) => [...o, ...added]);
      } else setMessage(t.errors.upload ?? null);
    } catch {
      setMessage(t.errors.upload ?? null);
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    const patch: MemberProfilePatch = {};
    if (occupation !== (profile.occupation ?? '')) patch.occupation = occupation;
    if (city !== (profile.cityLabel ?? '')) patch.cityLabel = city;
    if (knownFor !== (profile.knownFor ?? '')) patch.knownFor = knownFor;
    if (interests.join('|') !== profile.interests.join('|')) patch.interests = interests;
    if (order.join('|') !== profile.photos.map((p) => p.id).join('|')) patch.photoOrder = order;
    if (Object.keys(patch).length === 0) {
      router.back();
      return;
    }
    setSaving(true);
    setErrors([]);
    setMessage(null);
    const res = await actions.updateProfile(patch);
    setSaving(false);
    if (res.ok) {
      router.back();
      return;
    }
    if (res.error.kind === 'validation') setErrors(res.error.fields);
    else setMessage(t.errors.save ?? null);
  };

  const fieldError = (f: string) => (errors.includes(f) ? (t.errors[f] ?? null) : null);
  const menuIndex = photoMenu ? order.indexOf(photoMenu) : -1;

  return (
    <ScreenShell
      onBack={() => router.back()}
      testID="screen-edit-profile"
      footer={
        <View style={styles.footer}>
          <Notice message={message} />
          <Button label={t.save} onPress={() => void save()} loading={saving} testID="edit-save" />
        </View>
      }
    >
      <Text variant="headline" accessibilityRole="header" style={styles.title}>
        {t.title}
      </Text>

      <Section label={t.photos} hint={t.photosHint}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {photos.map((p, i) => (
            <Pressable
              key={p.id}
              onPress={() => setPhotoMenu(p.id)}
              accessibilityRole="button"
              accessibilityLabel={t.photoA11y(i + 1, photos.length)}
              testID={`edit-photo-${i}`}
            >
              <Photo photo={p} style={[styles.tile, i === 0 && styles.tileFirst]} />
            </Pressable>
          ))}
          {photos.length < PHOTO_MAX ? (
            <Pressable
              onPress={() => void add()}
              disabled={uploading}
              accessibilityRole="button"
              accessibilityLabel={t.addA11y}
              style={({ pressed }) => [styles.tile, styles.addTile, pressed && { opacity: 0.6 }]}
              testID="edit-add-photo"
            >
              <Text variant="label" tone="secondary">
                {uploading ? '…' : t.add}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
        {fieldError('photoOrder') ? <Notice message={fieldError('photoOrder')} /> : null}
      </Section>

      <Section label={t.occupation}>
        <TextField label={t.occupation} hideLabel size="title" value={occupation} onChangeText={setOccupation} error={fieldError('occupation')} grow testID="edit-occupation" />
      </Section>

      <Section label={t.city}>
        <TextField label={t.city} hideLabel size="title" value={city} onChangeText={setCity} error={fieldError('cityLabel')} testID="edit-city" />
      </Section>

      <Section label={t.knownFor}>
        <WritingField
          label={t.knownFor}
          value={knownFor}
          onChangeText={setKnownFor}
          min={LONG_TEXT_MIN}
          max={WHAT_YOU_DO_MAX}
          note={t.knownForNote}
          error={fieldError('knownFor')}
          testID="edit-known-for"
        />
      </Section>

      <Section label={t.interests}>
        <View style={styles.interestRow}>
          <Text variant="bodyLarge" style={styles.interestLine} testID="edit-interests">
            {joinNatural(interests)}
          </Text>
          <Button variant="quiet" label={t.change} onPress={() => setChoosing(true)} testID="edit-interests-change" />
        </View>
        {fieldError('interests') ? <Notice message={fieldError('interests')} /> : null}
      </Section>

      <Text variant="caption" tone="tertiary" style={styles.note}>
        {t.applicationNote}
      </Text>

      <Sheet visible={choosing} onClose={() => setChoosing(false)} fill title={t.interests} testID="edit-interests-sheet">
        <ScrollView style={styles.flex} contentContainerStyle={styles.sheetBody}>
          <InterestCurator
            groups={INTEREST_GROUPS}
            selected={interests}
            onToggle={(o) => setInterests((cur) => (cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]))}
            min={INTERESTS_MIN}
            max={INTERESTS_MAX}
          />
        </ScrollView>
        <Button label={copy.request.done} onPress={() => setChoosing(false)} disabled={interests.length < INTERESTS_MIN} testID="edit-interests-done" />
      </Sheet>

      <ActionSheet
        visible={photoMenu !== null}
        onClose={() => setPhotoMenu(null)}
        cancelLabel={copy.member.safety.cancel}
        header={
          photoMenu && order.length <= PHOTO_MIN ? (
            <Text variant="caption" tone="secondary">
              {t.minimum}
            </Text>
          ) : undefined
        }
        actions={[
          ...(menuIndex > 0
            ? [
                {
                  key: 'first',
                  label: t.makeFirst,
                  testID: 'photo-make-first',
                  onPress: () => {
                    setOrder((o) => [photoMenu!, ...o.filter((x) => x !== photoMenu)]);
                    setPhotoMenu(null);
                  },
                },
              ]
            : []),
          ...(order.length > PHOTO_MIN
            ? [
                {
                  key: 'remove',
                  label: t.remove,
                  destructive: true,
                  testID: 'photo-remove',
                  onPress: () => {
                    setOrder((o) => o.filter((x) => x !== photoMenu));
                    setPhotoMenu(null);
                  },
                },
              ]
            : []),
        ]}
        testID="photo-menu"
      />
    </ScreenShell>
  );
}

function Section({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="label" tone="secondary">
        {label}
      </Text>
      {hint ? (
        <Text variant="caption" tone="tertiary" style={styles.hint}>
          {hint}
        </Text>
      ) : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: color.background },
  flex: { flex: 1 },
  title: { marginBottom: space[6] },
  section: { marginBottom: space[8] },
  hint: { marginTop: 2 },
  sectionBody: { marginTop: space[3] },
  strip: { gap: space[2], paddingRight: space[4] },
  tile: { width: 84, height: 112, borderRadius: radius.control },
  tileFirst: { borderWidth: 1.5, borderColor: color.pearl },
  addTile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.hairlineStrong,
    backgroundColor: 'transparent',
  },
  interestRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space[4] },
  interestLine: { flex: 1 },
  note: { marginBottom: space[6] },
  footer: { gap: space[2] },
  sheetBody: { paddingBottom: space[4] },
});
