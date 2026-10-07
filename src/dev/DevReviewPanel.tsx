/**
 * DEVELOPMENT ONLY — the reviewer fixture's visible controls.
 *
 * Rendered only when DEV_FLAGS.panel is true (explicit opt-in env flag, never
 * when EXPO_PUBLIC_APP_ENV=production — src/config.ts; verified by the release
 * gate and the production E2E check). Every button calls the mock server's
 * reviewer endpoint — the same planning, transition validation and audit as
 * future review tooling. It cannot do anything a reviewer could not.
 */
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { DEV_FLAGS } from '@/config';
import { copy } from '@/copy/en';
import { color, radius, space } from '@/design/tokens';
import { INFORMATION_REQUEST_PRESETS, type InformationRequestPreset } from '@/domain/admission/informationRequests';
import { reviewerActionsFor, type ReviewerAction } from '@/domain/admission/review';
import type { MockAdmissionBackend } from '@/services/mock/mockAdmissionApi';
import { useAdmission } from '@/state/admission/AdmissionProvider';

type Option = { label: string; action: ReviewerAction | ((photoId: string | null) => ReviewerAction | null) };

const PRESETS = Object.keys(INFORMATION_REQUEST_PRESETS) as InformationRequestPreset[];

function optionsFor(kind: ReviewerAction['kind']): Option[] {
  switch (kind) {
    case 'START_REVIEW':
      return [{ label: 'Start review', action: { kind } }];
    case 'REQUEST_EXTENDED':
      return [{ label: 'Request extended application', action: { kind } }];
    case 'WAITLIST':
      return [{ label: 'Waitlist (capacity)', action: { kind, reason: 'CAPACITY' } }];
    case 'APPROVE':
      return [{ label: 'Approve', action: { kind, reason: 'COMMUNITY_FIT' } }];
    case 'NOT_ADMIT':
      return [{ label: 'Not admit', action: { kind, reason: 'APPLICATION_QUALITY' } }];
    case 'REOPEN':
      return [
        { label: 'Reopen → under review', action: { kind, to: 'UNDER_REVIEW' } },
        { label: 'Reopen → final review', action: { kind, to: 'FINAL_REVIEW' } },
      ];
    case 'REQUEST_INFORMATION':
      return PRESETS.map((preset) => ({
        label: `Request: ${preset}`,
        action: (photoId) =>
          INFORMATION_REQUEST_PRESETS[preset].type === 'REPLACE_PHOTO'
            ? photoId
              ? { kind, requests: [{ preset, mediaId: photoId }] }
              : null
            : { kind, requests: [{ preset }] },
      }));
  }
}

export function DevReviewPanel({ onChanged }: { onChanged: () => void }) {
  const status = useAdmission((s) => s.status);
  const userId = useAdmission((s) => s.session?.userId);
  if (process.env.EXPO_PUBLIC_APP_ENV === 'production' || !DEV_FLAGS.panel) return null;
  const dev = (globalThis as { __velvetDev?: MockAdmissionBackend['dev'] }).__velvetDev;
  const options = reviewerActionsFor(status).flatMap(optionsFor);
  if (!dev || !userId || options.length === 0) return null;
  return (
    <View style={styles.panel} testID="dev-review-panel">
      <Text variant="caption" tone="secondary">
        {copy.status.devPanel}
      </Text>
      {options.map((o) => (
        <Button
          key={o.label}
          variant="quiet"
          label={o.label}
          onPress={async () => {
            const snapshot = await dev.snapshot();
            const app = snapshot.applications[userId];
            const photoId =
              Object.values(snapshot.media)
                .filter((m) => m.applicationId === app?.id && m.purpose !== 'verification' && !m.retiredAt && m.order >= 0)
                .sort((a, b) => a.order - b.order)[0]?.id ?? null;
            const action = typeof o.action === 'function' ? o.action(photoId) : o.action;
            if (!action) return;
            try {
              await dev.review(userId, action);
            } finally {
              onChanged();
            }
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: space[10],
    padding: space[4],
    borderRadius: radius.control,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.muted,
    gap: space[1],
  },
});
