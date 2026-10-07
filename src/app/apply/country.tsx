import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { SearchableList } from '@/components/SearchableList';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import { searchCountries } from '@/domain/geo/countries';
import { stepHref } from '@/navigation/routes';
import { StepGuard } from '@/navigation/StepGuard';
import { useStep } from '@/navigation/useStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function CountryRoute() {
  return (
    <StepGuard step="country">
      <CountryScreen />
    </StepGuard>
  );
}

function CountryScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.draft.countryCode);
  const { progress, goNext, goBack, fromReview } = useStep('country');
  const committedCity = useAdmission((s) => s.draft.city);
  const [selected, setSelected] = useState<string | null>(committed);
  const [query, setQuery] = useState('');
  const options = useMemo(
    () => searchCountries(query).map((c) => ({ key: c.code, label: c.name })),
    [query],
  );

  const submit = () => {
    if (!selected) return;
    const changed = selected !== committed;
    if (!actions.setCountry(selected).ok) return;
    // A new country clears the city; when editing from Review, go straight to City.
    if (fromReview && changed && committedCity) router.replace(stepHref('city', true));
    else goNext();
  };

  return (
    <ScreenShell
      scroll={false}
      onBack={goBack}
      progress={progress}
      testID="screen-country"
      footer={<Button label={copy.common.continue} onPress={submit} disabled={!selected} testID="step-continue" />}
    >
      <Question headline={copy.country.headline} supporting={copy.country.supporting} />
      <View style={styles.list}>
        <SearchableList
          options={options}
          query={query}
          onQueryChange={setQuery}
          selectedKey={selected}
          onSelect={(o) => setSelected(o.key)}
          searchLabel={copy.country.search}
          empty={<Text tone="secondary">{copy.country.empty(query)}</Text>}
          testID="country-list"
        />
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, marginTop: space[8] },
});
