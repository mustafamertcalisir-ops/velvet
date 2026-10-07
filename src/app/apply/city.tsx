import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { SearchableList, type ListOption } from '@/components/SearchableList';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import { citiesFor, cityDisplayLabel, needsDisambiguation } from '@/domain/geo/cities';
import type { CityAnswer } from '@/domain/models';
import { foldForSearch, searchBy } from '@/domain/text/search';
import { validatePlaceName } from '@/domain/validation/name';
import { StepGuard } from '@/navigation/StepGuard';
import { useStep } from '@/navigation/useStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function CityRoute() {
  return (
    <StepGuard step="city">
      <CityScreen />
    </StepGuard>
  );
}

const TYPED_KEY = '__typed__';

function CityScreen() {
  const actions = useAdmissionActions();
  const countryCode = useAdmission((s) => s.draft.countryCode);
  const committed = useAdmission((s) => s.draft.city);
  const { progress, goNext, goBack } = useStep('city');

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CityAnswer | null>(committed);
  const [error, setError] = useState<string | null>(null);

  const cities = useMemo(() => (countryCode ? citiesFor(countryCode) : []), [countryCode]);
  const typed = validatePlaceName(query);
  const exactMatch = cities.some((c) => foldForSearch(c.name) === foldForSearch(query));

  const options: ListOption[] = useMemo(() => {
    const matches = searchBy(cities, query, (c) => [c.name, c.region ?? '']).map((c) => ({
      key: c.id,
      label: c.name,
      detail: needsDisambiguation(c, cities) ? (c.region ?? undefined) : undefined,
    }));
    // A typed city appears as its own row at the top, selected.
    if (selected?.kind === 'other' && !query) {
      return [{ key: TYPED_KEY, label: selected.label }, ...matches];
    }
    return matches;
  }, [cities, query, selected]);

  const selectedKey = selected ? (selected.kind === 'listed' ? selected.cityId : TYPED_KEY) : null;

  const select = (o: ListOption) => {
    setError(null);
    if (o.key === TYPED_KEY) {
      setSelected({ kind: 'other', label: o.label });
      return;
    }
    const city = cities.find((c) => c.id === o.key);
    if (city) {
      setSelected({ kind: 'listed', cityId: city.id, label: cityDisplayLabel(city, cities), region: city.region });
    }
  };

  const useTyped = () => {
    if (!typed.ok) {
      setError(copy.city.invalidTyped);
      return;
    }
    setSelected({ kind: 'other', label: typed.value });
    setQuery('');
  };

  const submit = () => {
    if (!selected) return;
    const r = actions.setCity(selected);
    if (!r.ok) {
      setError(copy.city.invalidTyped);
      return;
    }
    goNext();
  };

  const folded = foldForSearch(query);
  const startsAListedCity = cities.some((c) => foldForSearch(c.name).startsWith(folded));
  const showTyped = query.trim().length >= 2 && !exactMatch && !startsAListedCity;

  return (
    <ScreenShell
      scroll={false}
      onBack={goBack}
      progress={progress}
      testID="screen-city"
      footer={<Button label={copy.common.continue} onPress={submit} disabled={!selected} testID="step-continue" />}
    >
      <Question headline={copy.city.headline} />
      <View style={styles.list}>
        <SearchableList
          options={options}
          query={query}
          onQueryChange={(q) => {
            setQuery(q);
            setError(null);
          }}
          selectedKey={selectedKey}
          onSelect={select}
          searchLabel={copy.city.search}
          empty={
            !showTyped ? (
              <Text variant="supporting" tone="secondary">
                {copy.city.notListed}
              </Text>
            ) : null
          }
          footer={
            showTyped ? (
              <View>
                <Button
                  variant="secondary"
                  label={copy.city.useTyped(query.trim())}
                  onPress={useTyped}
                  testID="city-use-typed"
                />
                <Notice message={error} />
              </View>
            ) : (
              <Notice message={error} />
            )
          }
          testID="city-list"
        />
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, marginTop: space[8] },
});
