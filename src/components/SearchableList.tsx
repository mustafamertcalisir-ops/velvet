import { memo, useState, type ReactNode } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type ListRenderItem,
  type TextStyle,
} from 'react-native';

import { color, layout, space } from '@/design/tokens';
import { maxFontScale, type as typeScale } from '@/design/typography';
import { Text } from './Text';

export type ListOption = {
  key: string;
  label: string;
  /** Quiet trailing detail: a region for disambiguation, a calling code. */
  detail?: string;
};

/**
 * Searchable single selection. Used inline for Country and City and inside a
 * sheet for the phone country code. Rows are typeset lines separated by
 * hairlines — no cards — and the selection is marked with a Bosphorus tick.
 */
export function SearchableList({
  options,
  query,
  onQueryChange,
  selectedKey,
  onSelect,
  searchLabel,
  empty,
  footer,
  autoFocus = false,
  testID,
}: {
  options: readonly ListOption[];
  query: string;
  onQueryChange: (q: string) => void;
  selectedKey: string | null;
  onSelect: (option: ListOption) => void;
  searchLabel: string;
  empty?: ReactNode;
  footer?: ReactNode;
  autoFocus?: boolean;
  testID?: string;
}) {
  const [focused, setFocused] = useState(false);

  const renderItem: ListRenderItem<ListOption> = ({ item }) => (
    <Row option={item} selected={item.key === selectedKey} onSelect={onSelect} />
  );

  return (
    <View style={styles.root} testID={testID}>
      <View style={[styles.search, { borderBottomColor: focused ? color.focus : color.hairlineStrong }]}>
        <SearchGlyph />
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder={searchLabel}
          placeholderTextColor={color.textTertiary}
          accessibilityLabel={searchLabel}
          selectionColor={color.selection}
          cursorColor={color.caret}
          autoCorrect={false}
          autoCapitalize="words"
          autoFocus={autoFocus}
          returnKeyType="search"
          clearButtonMode="while-editing"
          maxFontSizeMultiplier={maxFontScale.body}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.searchInput, Platform.OS === 'web' && ({ outlineStyle: 'none' } as unknown as TextStyle)]}
          testID={testID ? `${testID}-search` : undefined}
        />
      </View>
      <FlatList
        data={options}
        keyExtractor={(o) => o.key}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={16}
        windowSize={8}
        ListEmptyComponent={empty ? <View style={styles.empty}>{empty}</View> : null}
        ListFooterComponent={footer ? <View style={styles.footer}>{footer}</View> : null}
        accessibilityRole="list"
        style={styles.list}
      />
    </View>
  );
}

const Row = memo(function Row({
  option,
  selected,
  onSelect,
}: {
  option: ListOption;
  selected: boolean;
  onSelect: (o: ListOption) => void;
}) {
  return (
    <Pressable
      onPress={() => onSelect(option)}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={option.detail ? `${option.label}, ${option.detail}` : option.label}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`option-${option.key}`}
    >
      <Text variant="bodyLarge" style={styles.rowLabel} numberOfLines={2}>
        {option.label}
      </Text>
      {option.detail ? (
        <Text variant="supporting" tone="secondary" style={styles.detail} numberOfLines={1}>
          {option.detail}
        </Text>
      ) : null}
      <View style={styles.tickSlot}>{selected ? <View style={styles.tick} /> : null}</View>
    </Pressable>
  );
});

function SearchGlyph() {
  return (
    <View style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.glyphRing} />
      <View style={styles.glyphHandle} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    gap: space[3],
  },
  searchInput: {
    ...(typeScale.body as object),
    flex: 1,
    color: color.text,
    paddingVertical: space[3],
    minHeight: layout.minTouchTarget,
  },
  list: { flex: 1, marginTop: space[2] },
  row: {
    minHeight: 54,
    paddingVertical: space[3],
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
    gap: space[3],
  },
  rowPressed: { opacity: 0.6 },
  rowLabel: { flex: 1 },
  detail: { flexShrink: 0, maxWidth: '45%', textAlign: 'right' },
  tickSlot: { width: 20, alignItems: 'flex-end' },
  tick: {
    width: 12,
    height: 7,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: color.pearl,
    transform: [{ rotate: '-45deg' }],
    marginBottom: 3,
  },
  empty: { paddingVertical: space[6] },
  footer: { paddingVertical: space[4] },
  glyph: { width: 16, height: 16 },
  glyphRing: {
    position: 'absolute',
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: color.textSecondary,
    top: 0,
    left: 0,
  },
  glyphHandle: {
    position: 'absolute',
    width: 6,
    height: 1.5,
    backgroundColor: color.textSecondary,
    transform: [{ rotate: '45deg' }],
    top: 12,
    left: 9,
  },
});
