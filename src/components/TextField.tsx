import { useCallback, useRef, useState, type ReactNode, type Ref } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps, type TextStyle } from 'react-native';

import { color, space } from '@/design/tokens';
import { maxFontScale, type as typeScale } from '@/design/typography';
import { useFocusVisibility } from './FocusVisibility';
import { Notice } from './Notice';
import { Text } from './Text';

/**
 * The answer field. No box: the typed answer (UI sans) sits on a single rule
 * that becomes a 2pt Pearl line on focus and the validation colour on error.
 * Errors sit beneath and are announced.
 */
export function TextField({
  label,
  error,
  hint,
  size = 'answer',
  leading,
  invalid = false,
  hideLabel = false,
  grow = false,
  caption,
  ref,
  style,
  onFocus,
  onBlur,
  ...input
}: TextInputProps & {
  label: string;
  error?: string | null;
  hint?: string | null;
  size?: 'answer' | 'title' | 'heroAnswer';
  leading?: ReactNode;
  /** The headline already asks the question; keep the label for assistive tech only. */
  hideLabel?: boolean;
  /**
   * Wrap onto further lines instead of scrolling sideways (long occupations,
   * long studio names). Still a one-line answer: Return submits, never breaks.
   */
  grow?: boolean;
  /** Quiet line under the rule (e.g. where the answer will appear). */
  caption?: string | null;
  /** Mark the rule as invalid without rendering a message (message shown elsewhere). */
  invalid?: boolean;
  ref?: Ref<TextInput>;
}) {
  const [focused, setFocused] = useState(false);
  const visibility = useFocusVisibility();
  const inputRef = useRef<TextInput | null>(null);
  const field = useCallback(() => inputRef.current, []);
  const setRef = useCallback(
    (node: TextInput | null) => {
      inputRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: TextInput | null }).current = node;
    },
    [ref],
  );
  // Long answers (double surnames, long cities) step down in size rather than clip.
  const length = typeof input.value === 'string' ? input.value.length : 0;
  const fit: TextStyle | null =
    size === 'answer' && length > 24
      ? { fontSize: 18, lineHeight: 24 }
      : size === 'answer' && length > 17
        ? { fontSize: 21, lineHeight: 27 }
        : size === 'heroAnswer' && length > 28
          ? { fontSize: 24, lineHeight: 31, letterSpacing: -0.3 }
          : size === 'heroAnswer' && length > 16
            ? { fontSize: 28, lineHeight: 35, letterSpacing: -0.4 }
            : null;
  const { onChangeText, onSubmitEditing } = input;
  const growProps: TextInputProps = grow
    ? {
        multiline: true,
        ...(Platform.OS === 'web' ? ({ rows: 1 } as object) : null),
        submitBehavior: 'blurAndSubmit',
        scrollEnabled: false,
        textAlignVertical: 'top',
        // A pasted or web-typed Return never becomes part of the answer.
        onChangeText: (v: string) => {
          if (v.includes('\n')) {
            onChangeText?.(v.replace(/\s*\n+\s*/g, ' ').trimEnd());
            if (/\n\s*$/.test(v)) onSubmitEditing?.({ nativeEvent: { text: v.trim() } } as never);
            return;
          }
          onChangeText?.(v);
        },
      }
    : {};
  const hasError = Boolean(error) || invalid;
  const lineColor = hasError ? color.error : color.hairlineStrong;
  return (
    <View>
      {hideLabel ? null : (
        <Text variant="label" tone="secondary" nativeID={input.nativeID ? `${input.nativeID}-label` : undefined}>
          {label}
        </Text>
      )}
      <View style={[styles.row, hideLabel && styles.rowBare, { borderBottomColor: lineColor }]}>
        {leading}
        <TextInput
          ref={setRef}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint ?? undefined}
          placeholderTextColor={color.textTertiary}
          selectionColor={color.selection}
          cursorColor={color.caret}
          maxFontSizeMultiplier={maxFontScale.display}
          {...input}
          {...growProps}
          onFocus={(e) => {
            setFocused(true);
            visibility?.focused(field);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            visibility?.blurred(field);
            onBlur?.(e);
          }}
          style={[
            styles.input,
            typeScale[size] as TextStyle,
            fit,
            webReset,
            grow ? webGrow : null,
            style,
          ]}
        />
        {focused || hasError ? (
          <View
            pointerEvents="none"
            style={[styles.focusRule, { backgroundColor: hasError ? color.error : color.focus }]}
          />
        ) : null}
      </View>
      {error ? (
        <Notice message={error} />
      ) : hint ? (
        <Notice message={hint} tone="info" announce={false} />
      ) : caption ? (
        <Text variant="caption" tone="tertiary" style={styles.caption}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

const webReset = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;
/**
 * Native multiline inputs grow with their content. A web textarea doesn't
 * (and starts two rows tall), so size it to its content there.
 */
const webGrow =
  Platform.OS === 'web' ? ({ fieldSizing: 'content', resize: 'none', overflow: 'hidden' } as unknown as TextStyle) : null;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderBottomWidth: 1,
    marginTop: space[2],
  },
  rowBare: { marginTop: 0 },
  caption: { marginTop: space[3] },
  focusRule: { position: 'absolute', left: 0, right: 0, bottom: -1, height: 2 },
  input: {
    flex: 1,
    minWidth: 0,
    color: color.text,
    paddingTop: space[2],
    paddingBottom: space[3],
    paddingHorizontal: 0,
    minHeight: 50,
  },
});
