import { useMemo, useState, type Ref } from 'react';
import { Pressable, StyleSheet, View, type TextInput } from 'react-native';

import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { countryByCode, searchCountries } from '@/domain/geo/countries';
import { formatAsYouType } from '@/domain/validation/phone';
import { Notice } from './Notice';
import { SearchableList } from './SearchableList';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { TextField } from './TextField';

/**
 * International phone input in two aligned columns:
 *   [ Country code ▾ ]  [ Mobile number              ]
 * The code is its own control (opens a searchable sheet) rather than a prefix
 * glued to the number, so the hierarchy reads: where → number. Türkiye (+90)
 * by default. Numbers are formatted as typed (libphonenumber metadata).
 * Errors and helper text span the full width beneath both columns.
 */
export function PhoneField({
  label,
  countryCode,
  onCountryChange,
  national,
  onNationalChange,
  onSubmit,
  error,
  hint,
  autoFocus,
  ref,
  testID,
}: {
  label: string;
  countryCode: string;
  onCountryChange: (code: string) => void;
  national: string;
  onNationalChange: (v: string) => void;
  onSubmit?: () => void;
  error?: string | null;
  hint?: string | null;
  autoFocus?: boolean;
  ref?: Ref<TextInput>;
  testID?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const country = countryByCode(countryCode);
  const options = useMemo(
    () =>
      searchCountries(query).map((c) => ({ key: c.code, label: c.name, detail: `+${c.callingCode}` })),
    [query],
  );

  return (
    <View>
      <View style={styles.row}>
        <Pressable
          onPress={() => setPicking(true)}
          accessibilityRole="button"
          accessibilityLabel={copy.phone.countryA11y(country?.name ?? countryCode, country?.callingCode ?? '')}
          style={({ pressed }) => [styles.code, pressed && { opacity: 0.6 }]}
          hitSlop={4}
          testID={testID ? `${testID}-country` : undefined}
        >
          <Text variant="label" tone="secondary">
            {copy.phone.codeLabel}
          </Text>
          <View style={[styles.codeValue, error ? { borderBottomColor: color.error } : null]}>
            <Text variant="answer" style={styles.codeText}>
              +{country?.callingCode}
            </Text>
            <View style={styles.chevron} />
          </View>
        </Pressable>
        <View style={styles.number}>
          <TextField
            ref={ref}
            label={label}
            value={national}
            onChangeText={(t) => {
              // Pasting a full international number is accepted as-is.
              onNationalChange(t.startsWith('+') ? t : formatAsYouType(t, countryCode));
            }}
            keyboardType="phone-pad"
            inputMode="tel"
            textContentType="telephoneNumber"
            autoComplete="tel"
            autoFocus={autoFocus}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            invalid={Boolean(error)}
            testID={testID}
          />
        </View>
      </View>
      {error ? <Notice message={error} testID={testID ? `${testID}-error` : undefined} /> : null}
      {!error && hint ? <Notice message={hint} tone="info" announce={false} /> : null}

      <Sheet visible={picking} onClose={() => setPicking(false)} title={copy.phone.pickCountry} fill>
        <SearchableList
          options={options}
          query={query}
          onQueryChange={setQuery}
          selectedKey={countryCode}
          onSelect={(o) => {
            onCountryChange(o.key);
            setQuery('');
            setPicking(false);
          }}
          searchLabel={copy.country.search}
          empty={<Text tone="secondary">{copy.country.empty(query)}</Text>}
          testID="phone-country-list"
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space[4] },
  code: { minWidth: 84 },
  codeValue: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space[2],
    minHeight: 50,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineStrong,
    gap: space[2],
  },
  codeText: { fontVariant: ['tabular-nums'], paddingTop: space[2], paddingBottom: space[3] },
  chevron: {
    width: 7,
    height: 7,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: color.textSecondary,
    transform: [{ rotate: '45deg' }],
    marginBottom: 4,
  },
  number: { flex: 1, minWidth: 0 },
});
