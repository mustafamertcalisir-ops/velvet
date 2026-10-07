import { StyleSheet, View } from 'react-native';

import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import type { StageSequence } from '@/domain/admission/statusStages';
import { Text } from './Text';

/**
 * Application status treatment: a short typeset sequence on one hairline.
 * Past stages are set quietly, the current stage in Pearl with a short
 * pomegranate rule beneath it, future stages faint. No icons, no dates per
 * stage, no percentages — it should never read as parcel tracking.
 */
export function StatusStages({ sequence }: { sequence: StageSequence }) {
  const labels = sequence.stages.map((s) => copy.status.stages[s]);
  const current = labels[sequence.currentIndex] ?? '';
  const rest = labels.slice(sequence.currentIndex + 1);
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={copy.status.stageA11y(current, rest)}
      style={styles.root}
      testID="status-stages"
    >
      <View style={styles.rule} />
      <View style={styles.row}>
        {labels.map((label, i) => {
          const state = i < sequence.currentIndex ? 'past' : i === sequence.currentIndex ? 'current' : 'future';
          return (
            <View key={label} style={styles.stage}>
              <View style={[styles.mark, state === 'current' && styles.markCurrent, state === 'past' && styles.markPast]} />
              <Text
                variant="label"
                tone={state === 'current' ? 'primary' : state === 'past' ? 'secondary' : 'tertiary'}
                style={state === 'future' && styles.future}
              >
                {label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingTop: 0 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.hairlineStrong },
  // Natural label widths with the space shared between them, so four stages
  // ("Final review") never crowd on a small phone.
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space[3] },
  stage: { flexShrink: 1 },
  mark: { height: 2, width: 24, marginTop: -1, marginBottom: space[3], backgroundColor: 'transparent' },
  markPast: { backgroundColor: color.hairlineStrong },
  markCurrent: { backgroundColor: color.stageMark },
  future: { opacity: 0.85 },
});
