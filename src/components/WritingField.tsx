import { useCallback, useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextStyle } from 'react-native';

import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { maxFontScale, type as typeScale } from '@/design/typography';
import { useFocusVisibility } from './FocusVisibility';
import { Notice } from './Notice';
import { Text } from './Text';

/**
 * A writing moment rather than a form field: no box and no visible label
 * (the headline asks the question), comfortable sans at reading size, a page
 * that grows with the answer, and one hairline beneath with a quiet note and
 * a live count. The count only takes the validation colour when it matters.
 */
export function WritingField({
  label,
  value,
  onChangeText,
  placeholder,
  max,
  min,
  note,
  error,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  max: number;
  min: number;
  /** Shown once the minimum is met, in place of the minimum hint. */
  note?: string;
  error?: string | null;
  testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  const visibility = useFocusVisibility();
  const inputRef = useRef<TextInput>(null);
  const field = useCallback(() => inputRef.current, []);
  const length = value.trim().length;
  const over = length > max;
  const ruleColor = error || over ? color.error : focused ? color.hairlineStrong : color.hairline;
  return (
    <View>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        multiline
        scrollEnabled={false}
        textAlignVertical="top"
        placeholder={placeholder}
        accessibilityLabel={label}
        accessibilityHint={copy.extended.longTextMin(min)}
        placeholderTextColor={color.textTertiary}
        selectionColor={color.selection}
        cursorColor={color.caret}
        maxFontSizeMultiplier={maxFontScale.body}
        onFocus={() => {
          setFocused(true);
          visibility?.focused(field);
        }}
        onBlur={() => {
          setFocused(false);
          visibility?.blurred(field);
        }}
        style={[
          styles.input,
          { minHeight: MIN_HEIGHT },
          // Native multiline inputs grow with their content; a web textarea needs telling.
          Platform.OS === 'web' &&
            ({ outlineStyle: 'none', resize: 'none', fieldSizing: 'content', overflow: 'hidden' } as unknown as TextStyle),
        ]}
        testID={testID}
      />
      <View style={[styles.meta, { borderTopColor: ruleColor }]}>
        <Text variant="caption" tone="tertiary" style={styles.note}>
          {length >= min && note ? note : copy.extended.longTextMin(min)}
        </Text>
        <Text variant="numeral" tone={over ? 'error' : 'tertiary'} testID={testID ? `${testID}-count` : undefined}>
          {copy.extended.longTextCount(length, max)}
        </Text>
      </View>
      <Notice message={error} />
    </View>
  );
}

/** Five lines of `writing` — enough page to invite a real answer. */
const MIN_HEIGHT = typeScale.writing.lineHeight * 5;

const styles = StyleSheet.create({
  input: {
    ...(typeScale.writing as object),
    color: color.text,
    padding: 0,
    paddingBottom: space[4],
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: space[4],
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space[3],
  },
  note: { flex: 1 },
});
