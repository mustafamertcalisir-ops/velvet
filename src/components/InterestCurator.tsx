import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { copy } from '@/copy/en';
import { color, layout, space } from '@/design/tokens';
import { joinNatural } from '@/domain/profile/profilePresentation';
import { Notice } from './Notice';
import { Text } from './Text';

export type InterestGroup = { id: string; label: string; items: readonly string[] };

/**
 * Interests as a small, curated collection rather than a tag cloud.
 *
 *  1. The collection — what has been chosen, typeset as the sentence it will
 *     become on the profile, with a tabular count against the limit.
 *  2. Rooms — five text tabs (Culture, Ideas, …), each showing how many of
 *     its interests are chosen, so nothing is "lost" in another room.
 *  3. The room's interests as one quiet column of rows: chosen rows step
 *     forward to Pearl with a drawn tick; at the limit the rest step back
 *     and say why.
 *
 * One column, at most eight rows per room — short, scannable, and long labels
 * never wrap into a grid.
 */
export function InterestCurator({
  groups,
  selected,
  onToggle,
  min,
  max,
}: {
  groups: readonly InterestGroup[];
  selected: readonly string[];
  onToggle: (item: string) => void;
  min: number;
  max: number;
}) {
  const t = copy.extended.interests;
  const [active, setActive] = useState(groups[0]?.id);
  const [rowWidth, setRowWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const tabFrames = useRef<Record<string, { x: number; width: number }>>({});
  const overflow = rowWidth > 0 && contentWidth > rowWidth + 1;

  // Keep the active room in view when the row scrolls.
  useEffect(() => {
    const frame = active ? tabFrames.current[active] : undefined;
    if (!overflow || !frame) return;
    scrollRef.current?.scrollTo({ x: Math.max(0, frame.x - layout.gutter), animated: false });
  }, [active, overflow]);
  const room = groups.find((g) => g.id === active) ?? groups[0];
  const atLimit = selected.length >= max;

  return (
    <View>
      <View style={styles.collection} accessibilityLiveRegion="polite">
        <Text
          variant={selected.length ? 'readback' : 'supporting'}
          tone={selected.length ? 'primary' : 'tertiary'}
          style={styles.sentence}
          testID="interest-summary"
        >
          {selected.length ? `${joinNatural(selected)}.` : t.empty}
        </Text>
        <Text variant="numeral" tone={selected.length >= min ? 'secondary' : 'tertiary'} testID="interest-count">
          {t.count(selected.length, max)}
        </Text>
      </View>
      <Text variant="caption" tone="tertiary" style={styles.rule}>
        {selected.length < min ? t.needMore(min - selected.length) : atLimit ? t.full : t.room(max - selected.length)}
      </Text>

      {/*
        Rooms fill the row when they fit (every room visible at 375–430).
        With larger text they no longer fit: the row scrolls, a fade at the
        trailing edge says there is more, and the active room is kept in view.
      */}
      <View style={styles.tabsWrap} onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}>
        <ScrollView
          ref={scrollRef}
          horizontal
          scrollEnabled={overflow}
          showsHorizontalScrollIndicator={false}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            setAtEnd(contentOffset.x + layoutMeasurement.width >= contentSize.width - 4);
          }}
          scrollEventThrottle={32}
          onContentSizeChange={(w) => setContentWidth(w)}
          contentContainerStyle={[styles.tabs, !overflow && styles.tabsFit]}
          accessibilityRole="tablist"
        >
          {groups.map((g) => {
            const on = g.id === room?.id;
            const chosen = g.items.filter((i) => selected.includes(i)).length;
            return (
              <Pressable
                key={g.id}
                onPress={() => setActive(g.id)}
                onLayout={(e) => {
                  const { x, width } = e.nativeEvent.layout;
                  tabFrames.current[g.id] = { x, width };
                }}
                hitSlop={{ left: 8, right: 8 }}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={chosen ? t.tabA11y(g.label, chosen) : g.label}
                style={styles.tab}
                testID={`interest-tab-${g.id}`}
              >
                <View style={styles.tabLabel}>
                  <Text variant="label" tone={on ? 'primary' : 'secondary'} numberOfLines={1}>
                    {g.label}
                  </Text>
                  {chosen ? (
                    <Text variant="numeral" tone={on ? 'secondary' : 'tertiary'} style={styles.tabCount}>
                      {chosen}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.tabRule, on && styles.tabRuleOn]} />
              </Pressable>
            );
          })}
        </ScrollView>
        {overflow && !atEnd ? (
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(11,11,12,0)', color.obsidian]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.fade}
          />
        ) : null}
      </View>

      <View accessibilityRole="list" style={styles.rows}>
        {room?.items.map((item) => {
          const on = selected.includes(item);
          const disabled = atLimit && !on;
          return (
            <Pressable
              key={item}
              onPress={disabled ? undefined : () => onToggle(item)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled }}
              accessibilityLabel={item}
              style={({ pressed }) => [styles.row, pressed && !disabled && { opacity: 0.6 }]}
              testID={`interest-${item}`}
            >
              <Text variant="bodyLarge" tone={on ? 'primary' : disabled ? 'tertiary' : 'secondary'} style={styles.item}>
                {item}
              </Text>
              <View style={styles.markSlot}>{on ? <View style={styles.tick} /> : null}</View>
            </Pressable>
          );
        })}
      </View>
      {atLimit ? <Notice message={t.limit(max)} tone="info" testID="interest-limit" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  collection: { flexDirection: 'row', alignItems: 'flex-start', gap: space[4], minHeight: 31 },
  sentence: { flex: 1, minWidth: 0 },
  rule: { marginTop: space[2] },
  tabsWrap: {
    marginTop: space[8],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  tabs: { gap: space[5] },
  /** When every room fits, spread them across the full measure. */
  tabsFit: { flexGrow: 1, justifyContent: 'space-between', gap: space[3] },
  fade: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 40 },
  tab: { minHeight: layout.minTouchTarget, justifyContent: 'flex-end' },
  tabLabel: { flexDirection: 'row', alignItems: 'baseline', gap: 5, paddingBottom: space[3] },
  tabCount: { fontSize: 12 },
  tabRule: { height: 2, backgroundColor: 'transparent' },
  tabRuleOn: { backgroundColor: color.pearl },
  rows: { marginTop: space[2] },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  item: { flex: 1, minWidth: 0 },
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
});
