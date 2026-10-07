/**
 * Billing boundary (DEC-047).
 *
 * The app never activates a membership itself. A billing provider takes the
 * applicant through checkout; the provider then confirms payment to OUR
 * server, which moves MEMBERSHIP_PAYMENT_REQUIRED → ACTIVE_MEMBER. The client
 * only refreshes afterwards.
 *
 * No real provider is integrated yet:
 *   - release builds use `unavailableBilling` (activation is shown as not yet open);
 *   - development/test builds may use the development fixture, which asks the
 *     mock server to record a fixture payment confirmation.
 */
import type { MembershipPlan } from '@/domain/membership/plan';

export type CheckoutResult = { ok: true } | { ok: false; reason: 'unavailable' | 'cancelled' | 'failed' };

export interface BillingProvider {
  readonly kind: 'unavailable' | 'development_fixture';
  checkout(input: { userId: string; plan: MembershipPlan }): Promise<CheckoutResult>;
}

export const unavailableBilling: BillingProvider = {
  kind: 'unavailable',
  checkout: async () => ({ ok: false, reason: 'unavailable' }),
};

/** Development and tests only — never constructed in release builds (src/services/index.ts). */
export function developmentFixtureBilling(confirm: (userId: string) => Promise<unknown>): BillingProvider {
  // Build-time constant: the fixture body is removed from release bundles.
  if (process.env.EXPO_PUBLIC_APP_ENV === 'production') return unavailableBilling;
  return {
    kind: 'development_fixture',
    async checkout({ userId, plan }) {
      if (!plan.isDevelopmentFixture) return { ok: false, reason: 'unavailable' };
      try {
        await confirm(userId);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'failed' };
      }
    },
  };
}
