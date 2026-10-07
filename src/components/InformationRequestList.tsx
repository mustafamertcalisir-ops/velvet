import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { copy } from '@/copy/en';
import { color, radius, space } from '@/design/tokens';
import type { ApplicantInformationRequest } from '@/domain/admission/informationRequests';
import { Button } from './Button';
import { Text } from './Text';

export function requestTitle(r: Pick<ApplicantInformationRequest, 'type' | 'target'>): string {
  if (r.type === 'UPDATE_APPLICATION_FIELD' && r.target?.kind === 'field') {
    return copy.request.fieldTitle[r.target.field] ?? copy.request.types.UPDATE_APPLICATION_FIELD.title;
  }
  return copy.request.types[r.type].title;
}

export function requestAction(r: Pick<ApplicantInformationRequest, 'type'>): string {
  return copy.request.types[r.type].action;
}

/**
 * The requested items, typeset on hairlines: what is needed, why (the
 * reviewer's preset explanation), and — for a photo — which one. An answered
 * item says "Ready to send" and can still be changed. The first open item's
 * action is the screen's primary button, so it is not repeated here.
 */
export function InformationRequestList({
  requests,
  primaryId,
  onOpen,
}: {
  requests: readonly ApplicantInformationRequest[];
  primaryId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <View testID="information-requests">
      {requests.map((r, i) => {
        const answered = r.status === 'answered';
        const thumb =
          (answered && r.response?.kind === 'photo' ? r.response.uri : null) ??
          (r.current?.kind === 'photo' ? r.current.uri : null);
        return (
          <View key={r.id} style={[styles.item, i > 0 && styles.divider]} testID={`request-${r.type}`}>
            <View style={styles.row}>
              <View style={styles.text}>
                <Text variant="title">{requestTitle(r)}</Text>
                <Text variant="supporting" tone="secondary" style={styles.explanation}>
                  {r.explanation}
                </Text>
                {answered ? (
                  <View style={styles.ready} accessibilityLabel={copy.status.requests.readyToSend}>
                    <View style={styles.tick} />
                    <Text variant="label" testID={`request-ready-${r.type}`}>
                      {copy.status.requests.readyToSend}
                    </Text>
                  </View>
                ) : null}
              </View>
              {thumb ? <Image source={{ uri: thumb }} style={[styles.thumb, !answered && styles.thumbFaded]} contentFit="cover" /> : null}
            </View>
            {answered || r.id !== primaryId ? (
              <Button
                variant="quiet"
                label={answered ? copy.status.requests.change : requestAction(r)}
                accessibilityLabel={`${answered ? copy.status.requests.change : requestAction(r)}: ${requestTitle(r)}`}
                onPress={() => onOpen(r.id)}
                style={styles.action}
                testID={`request-open-${r.type}`}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { paddingVertical: space[5] },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  row: { flexDirection: 'row', gap: space[4], alignItems: 'flex-start' },
  text: { flex: 1, minWidth: 0 },
  explanation: { marginTop: space[1] },
  ready: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginTop: space[3] },
  tick: {
    width: 11,
    height: 6,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: color.pearl,
    transform: [{ rotate: '-45deg' }],
    marginTop: -3,
  },
  thumb: { width: 54, height: 72, borderRadius: radius.control - 4, backgroundColor: color.surface },
  thumbFaded: { opacity: 0.72 },
  action: { marginTop: space[3] },
});
