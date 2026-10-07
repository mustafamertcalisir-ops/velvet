import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View, type TextStyle } from 'react-native';

import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { Text } from './Text';

export const OTP_LENGTH = 6;

/** Keep only digits, capped at the code length. Handles pasted "246 810" etc. */
export function sanitizeOtp(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, OTP_LENGTH);
}

/**
 * Six digit positions, grouped 3 + 3, each on its own short rule.
 *
 * - empty positions show a small dot, so the length is legible at a glance
 * - the active position has a brighter, thicker rule and a caret
 * - filled digits are set in tabular sans numerals
 * - error tints every rule with the validation colour
 *
 * Backed by ONE real TextInput, so paste, iOS `oneTimeCode` and Android
 * `sms-otp` autofill and screen readers all work natively.
 */
export function OtpField({
  value,
  onChange,
  onComplete,
  error,
  disabled,
  autoFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete: (v: string) => void;
  error?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const activeIndex = Math.min(value.length, OTP_LENGTH - 1);

  const cell = (i: number) => {
    const char = value[i] ?? '';
    const active = focused && !disabled && i === activeIndex && value.length < OTP_LENGTH;
    return (
      <View
        key={i}
        style={[
          styles.cell,
          char ? styles.cellFilled : null,
          active ? styles.cellActive : null,
          error ? styles.cellError : null,
        ]}
      >
        {char ? (
          <Text variant="answer" style={styles.digit}>
            {char}
          </Text>
        ) : active ? (
          <View style={styles.caret} />
        ) : (
          <View style={styles.dot} />
        )}
      </View>
    );
  };

  return (
    <Pressable onPress={() => input.current?.focus()} accessible={false}>
      <View style={styles.row} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <View style={styles.group}>{[0, 1, 2].map(cell)}</View>
        <View style={styles.group}>{[3, 4, 5].map(cell)}</View>
      </View>
      <TextInput
        ref={input}
        testID="otp-input"
        value={value}
        onChangeText={(t) => {
          const next = sanitizeOtp(t);
          onChange(next);
          if (next.length === OTP_LENGTH) onComplete(next);
        }}
        editable={!disabled}
        autoFocus={autoFocus}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="oneTimeCode"
        autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
        maxLength={OTP_LENGTH + 4 /* allow pasted spaces before sanitising */}
        accessibilityLabel={copy.otp.label}
        accessibilityHint={copy.otp.a11yHint}
        caretHidden
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.hiddenInput, Platform.OS === 'web' && ({ outlineStyle: 'none' } as unknown as TextStyle)]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space[5] },
  group: { flex: 1, flexDirection: 'row', gap: space[2] },
  cell: {
    flex: 1,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineStrong,
  },
  cellFilled: { borderBottomColor: color.smoke },
  cellActive: { borderBottomWidth: 2, borderBottomColor: color.focus },
  cellError: { borderBottomColor: color.error },
  digit: { fontSize: 28, lineHeight: 34, fontVariant: ['tabular-nums'], textAlign: 'center' },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: color.muted },
  caret: { width: 2, height: 26, borderRadius: 1, backgroundColor: color.caret },
  hiddenInput: {
    ...(StyleSheet.absoluteFill as object),
    opacity: 0.011,
    color: 'transparent',
    fontSize: 28,
  },
});
