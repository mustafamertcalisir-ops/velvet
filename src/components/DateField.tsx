import { useRef } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import type { DobParts } from '@/domain/validation/dateOfBirth';
import { Notice } from './Notice';
import { TextField } from './TextField';

/**
 * Day / Month / Year in Türkiye's order (GG.AA.YYYY). Three numeric fields
 * rather than a wheel: faster to type, works on every platform and with
 * screen readers, and keeps the decision visible. Focus advances on its own.
 */
export function DateField({
  value,
  onChange,
  onSubmit,
  error,
}: {
  value: DobParts;
  onChange: (v: DobParts) => void;
  onSubmit: () => void;
  error?: string | null;
}) {
  const day = useRef<TextInput>(null);
  const month = useRef<TextInput>(null);
  const year = useRef<TextInput>(null);
  const digits = (s: string, n: number) => s.replace(/\D/g, '').slice(0, n);

  return (
    <View accessibilityRole="none" accessibilityLabel={copy.dob.groupA11y}>
      <View style={styles.row}>
        <View style={styles.short}>
          <TextField
            ref={day}
            label={copy.dob.day}
            placeholder="DD"
            value={value.day}
            onChangeText={(t) => {
              const d = digits(t, 2);
              onChange({ ...value, day: d });
              if (d.length === 2) month.current?.focus();
            }}
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="birthdate-day"
            autoFocus
            returnKeyType="next"
            testID="dob-day"
          />
        </View>
        <View style={styles.short}>
          <TextField
            ref={month}
            label={copy.dob.month}
            placeholder="MM"
            value={value.month}
            onChangeText={(t) => {
              const m = digits(t, 2);
              onChange({ ...value, month: m });
              if (m.length === 2) year.current?.focus();
            }}
            onKeyPress={(e) => {
              if (e.nativeEvent.key === 'Backspace' && value.month === '') day.current?.focus();
            }}
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="birthdate-month"
            returnKeyType="next"
            testID="dob-month"
          />
        </View>
        <View style={styles.long}>
          <TextField
            ref={year}
            label={copy.dob.year}
            placeholder="YYYY"
            value={value.year}
            onChangeText={(t) => onChange({ ...value, year: digits(t, 4) })}
            onKeyPress={(e) => {
              if (e.nativeEvent.key === 'Backspace' && value.year === '') month.current?.focus();
            }}
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="birthdate-year"
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            testID="dob-year"
          />
        </View>
      </View>
      <Notice message={error} testID="dob-error" />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space[5] },
  short: { flex: 2, minWidth: 0 },
  long: { flex: 3, minWidth: 0 },
});
