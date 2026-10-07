/**
 * Starter city list. Türkiye-first, not Türkiye-only (DEC-020).
 *
 * This is seed data for the mock backend. In production the list should be
 * served by the API (docs/DATA_MODEL.md §11). Any city not listed can be
 * entered by the applicant ("other"), so coverage gaps never block applying.
 */
import type { City, CountryCode } from '../models';

const TR_PROVINCES = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Aksaray', 'Amasya', 'Ankara', 'Antalya',
  'Ardahan', 'Artvin', 'Aydın', 'Balıkesir', 'Bartın', 'Batman', 'Bayburt', 'Bilecik',
  'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum',
  'Denizli', 'Diyarbakır', 'Düzce', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir',
  'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkâri', 'Hatay', 'Iğdır', 'Isparta', 'İstanbul',
  'İzmir', 'Kahramanmaraş', 'Karabük', 'Karaman', 'Kars', 'Kastamonu', 'Kayseri', 'Kilis',
  'Kırıkkale', 'Kırklareli', 'Kırşehir', 'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa',
  'Mardin', 'Mersin', 'Muğla', 'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Osmaniye',
  'Rize', 'Sakarya', 'Samsun', 'Şanlıurfa', 'Siirt', 'Sinop', 'Şırnak', 'Sivas',
  'Tekirdağ', 'Tokat', 'Trabzon', 'Tunceli', 'Uşak', 'Van', 'Yalova', 'Yozgat', 'Zonguldak',
] as const;

/** Cities shown first for Türkiye — where most applicants are expected. */
const TR_FEATURED = ['İstanbul', 'Ankara', 'İzmir', 'Antalya', 'Muğla', 'Bursa'];

type Seed = [name: string, region: string | null];

const INTERNATIONAL: Record<CountryCode, Seed[]> = {
  GB: [['London', 'England'], ['Manchester', 'England'], ['Edinburgh', 'Scotland'], ['Oxford', 'England'], ['Cambridge', 'England']],
  US: [
    ['New York', 'New York'], ['Los Angeles', 'California'], ['San Francisco', 'California'],
    ['Miami', 'Florida'], ['Chicago', 'Illinois'], ['Boston', 'Massachusetts'],
    ['Washington', 'District of Columbia'], ['Austin', 'Texas'],
    ['Portland', 'Oregon'], ['Portland', 'Maine'],
    ['Springfield', 'Illinois'], ['Springfield', 'Massachusetts'],
  ],
  DE: [['Berlin', null], ['Munich', 'Bavaria'], ['Hamburg', null], ['Frankfurt', 'Hesse'], ['Cologne', 'North Rhine-Westphalia'], ['Frankfurt (Oder)', 'Brandenburg']],
  FR: [['Paris', 'Île-de-France'], ['Lyon', 'Auvergne-Rhône-Alpes'], ['Marseille', "Provence-Alpes-Côte d'Azur"], ['Nice', "Provence-Alpes-Côte d'Azur"], ['Bordeaux', 'Nouvelle-Aquitaine']],
  IT: [['Milan', 'Lombardy'], ['Rome', 'Lazio'], ['Florence', 'Tuscany'], ['Venice', 'Veneto'], ['Naples', 'Campania']],
  ES: [['Madrid', null], ['Barcelona', 'Catalonia'], ['Valencia', null], ['Seville', 'Andalusia'], ['Ibiza', 'Balearic Islands']],
  NL: [['Amsterdam', 'North Holland'], ['Rotterdam', 'South Holland'], ['The Hague', 'South Holland']],
  BE: [['Brussels', null], ['Antwerp', 'Flanders']],
  CH: [['Zürich', null], ['Geneva', null], ['Basel', null]],
  AT: [['Vienna', null], ['Salzburg', null]],
  PT: [['Lisbon', null], ['Porto', null]],
  GR: [['Athens', 'Attica'], ['Thessaloniki', 'Central Macedonia'], ['Mykonos', 'South Aegean']],
  CY: [['Nicosia', null], ['Limassol', null], ['Kyrenia', null], ['Famagusta', null]],
  SE: [['Stockholm', null], ['Gothenburg', null]],
  DK: [['Copenhagen', null]],
  NO: [['Oslo', null]],
  FI: [['Helsinki', null]],
  IE: [['Dublin', null]],
  PL: [['Warsaw', null], ['Kraków', null]],
  CZ: [['Prague', null]],
  HU: [['Budapest', null]],
  AZ: [['Baku', null]],
  GE: [['Tbilisi', null], ['Batumi', null]],
  AE: [['Dubai', null], ['Abu Dhabi', null]],
  QA: [['Doha', null]],
  SA: [['Riyadh', null], ['Jeddah', null]],
  EG: [['Cairo', null], ['Alexandria', null]],
  LB: [['Beirut', null]],
  JO: [['Amman', null]],
  IL: [['Tel Aviv', null], ['Jerusalem', null]],
  RU: [['Moscow', null], ['Saint Petersburg', null]],
  UA: [['Kyiv', null], ['Odesa', null]],
  CA: [['Toronto', 'Ontario'], ['Montréal', 'Quebec'], ['Vancouver', 'British Columbia'], ['London', 'Ontario']],
  AU: [['Sydney', 'New South Wales'], ['Melbourne', 'Victoria']],
  JP: [['Tokyo', null], ['Kyoto', null]],
  SG: [['Singapore', null]],
  HK: [['Hong Kong', null]],
  KR: [['Seoul', null]],
  BR: [['São Paulo', null], ['Rio de Janeiro', null]],
  MX: [['Mexico City', null]],
  AR: [['Buenos Aires', null]],
  ZA: [['Cape Town', 'Western Cape'], ['Johannesburg', 'Gauteng']],
  MA: [['Marrakesh', null], ['Casablanca', null]],
};

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function build(): City[] {
  const featured = TR_FEATURED.map((name) => ({ name, region: null as string | null }));
  const rest = TR_PROVINCES.filter((p) => !TR_FEATURED.includes(p)).map((name) => ({ name, region: null }));
  const cities: City[] = [...featured, ...rest].map(({ name, region }) => ({
    id: `TR-${slug(name)}`,
    countryCode: 'TR',
    name,
    region,
  }));
  for (const [countryCode, seeds] of Object.entries(INTERNATIONAL)) {
    for (const [name, region] of seeds) {
      cities.push({
        id: `${countryCode}-${slug(name)}${region ? `-${slug(region)}` : ''}`,
        countryCode,
        name,
        region,
      });
    }
  }
  return cities;
}

export const CITIES: readonly City[] = build();

export function citiesFor(countryCode: CountryCode): City[] {
  return CITIES.filter((c) => c.countryCode === countryCode);
}

/** Names that appear more than once in a country need their region shown. */
export function needsDisambiguation(city: City, within: readonly City[]): boolean {
  return within.filter((c) => c.name === city.name).length > 1;
}

export function cityDisplayLabel(city: City, within: readonly City[]): string {
  return needsDisambiguation(city, within) && city.region ? `${city.name}, ${city.region}` : city.name;
}
