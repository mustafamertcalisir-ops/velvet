/**
 * Membership plans (DEC-047).
 *
 * One plan, named simply "Membership" — no tiers, no metal names. Pricing is
 * NOT finalised: until it is, the server returns a plan flagged
 * `isDevelopmentFixture`, and the interface says so instead of presenting a
 * made-up price as a commercial decision. Prices live in data, never in copy.
 */
export type MembershipPlan = {
  id: string;
  name: string;
  billingPeriod: 'monthly' | 'annual';
  /** Minor units (kuruş, cents). */
  priceMinor: number;
  /** ISO 4217. */
  currency: string;
  isDevelopmentFixture: boolean;
};

const SYMBOL: Record<string, string> = { TRY: '₺', EUR: '€', USD: '$', GBP: '£' };

/** "₺2,500" — whole units when exact, two decimals otherwise. */
export function formatPrice(plan: Pick<MembershipPlan, 'priceMinor' | 'currency'>): string {
  // Formatted by hand: identical on every JS engine (Intl support varies).
  const whole = Math.floor(plan.priceMinor / 100);
  const cents = plan.priceMinor % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const n = cents === 0 ? grouped : `${grouped}.${String(cents).padStart(2, '0')}`;
  const symbol = SYMBOL[plan.currency];
  return symbol ? `${symbol}${n}` : `${n} ${plan.currency}`;
}
