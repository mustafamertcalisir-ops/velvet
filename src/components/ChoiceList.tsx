import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { color, layout, radius, space } from '@/design/tokens';
import { Reveal } from './Reveal';
import { Text } from './Text';

export type Choice<K extends string> = { key: K; label: string; detail?: string };

/**
 * Single or multiple choice as typeset answers rather than form controls.
 *
 * Unselected answers sit back in Smoke. The chosen answer steps forward:
 * Pearl title, a quiet Ink band, a short Pearl rule at its leading edge and a
 * small drawn tick. No radio circles, no cards, no pills. A chosen answer can
 * open a follow-up (e.g. the studio's name) inside its own band, so the
 * question and its detail read as one thought.
 */
export function ChoiceList<K extends string>({
  choices,
  selected,
  onToggle,
  multiple = false,
  renderExpanded,
  testID,
}: {
  choices: readonly Choice<K>[];
  selected: readonly K[];
  onToggle: (key: K) => void;
  multiple?: boolean;
  /** Follow-up content shown inside a selected answer. */
  renderExpanded?: (key: K) => ReactNode;
  testID?: string;
}) {
  return (
    <View accessibilityRole={multiple ? 'list' : 'radiogroup'} style={styles.list} testID={testID}>
      {choices.map((c) => {
        const on = selected.includes(c.key);
        const expanded = on ? renderExpanded?.(c.key) : null;
        return (
          <View key={c.key} style={[styles.band, on && styles.bandOn]}>
            {on ? <View style={styles.rule} /> : null}
            <Pressable
              onPress={() => onToggle(c.key)}
              accessibilityRole={multiple ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: on, selected: on }}
              aria-checked={on}
              accessibilityLabel={c.detail ? `${c.label}. ${c.detail}` : c.label}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              testID={`choice-${c.key}`}
            >
              <View style={styles.text}>
                <Text variant="title" tone={on ? 'primary' : 'secondary'}>
                  {c.label}
                </Text>
                {c.detail ? (
                  <Text variant="supporting" tone={on ? 'secondary' : 'tertiary'} style={styles.detail}>
                    {c.detail}
                  </Text>
                ) : null}
              </View>
              <View style={styles.markSlot}>{on ? <View style={styles.tick} /> : null}</View>
            </Pressable>
            {expanded ? <Reveal style={styles.expanded}>{expanded}</Reveal> : null}
          </View>
        );
      })}
    </View>
  );
}

const inset = space[4];

const styles = StyleSheet.create({
  // Bands bleed slightly into the gutter so the text keeps the headline's left edge.
  list: { marginHorizontal: -inset, gap: space[1] },
  band: { borderRadius: radius.control - 2, overflow: 'hidden' },
  bandOn: { backgroundColor: color.surface },
  rule: { position: 'absolute', left: 0, top: space[4], width: 2, height: 24, backgroundColor: color.pearl },
  row: {
    minHeight: layout.minTouchTarget + space[4],
    paddingVertical: space[4],
    paddingHorizontal: inset,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[4],
  },
  text: { flex: 1, minWidth: 0 },
  detail: { marginTop: 3 },
  markSlot: { width: 18, alignItems: 'center' },
  tick: {
    width: 13,
    height: 7,
    borderLeftWidth: 1.75,
    borderBottomWidth: 1.75,
    borderColor: color.pearl,
    transform: [{ rotate: '-45deg' }],
    marginTop: -3,
  },
  expanded: { paddingHorizontal: inset, paddingBottom: space[5] },
});
