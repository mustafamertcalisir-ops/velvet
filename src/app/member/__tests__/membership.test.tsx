/**
 * The member's Membership screen states plainly what they have (DEC-047,
 * DEC-088): a billed membership keeps the billing note; an invited membership
 * (started by the membership team, no payment) says so, with no renewal date.
 */
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { OwnMember } from '@/services/api/memberTypes';

import MembershipDetails from '../membership';

let mockMe: Pick<OwnMember, 'membership'> | null = null;
jest.mock('expo-router', () => ({ router: { back: jest.fn() } }));
jest.mock('@/state/member/MemberProvider', () => ({
  useMember: (select: (s: { me: unknown }) => unknown) => select({ me: mockMe }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const show = () =>
  render(
    <SafeAreaProvider initialMetrics={metrics}>
      <MembershipDetails />
    </SafeAreaProvider>,
  );

describe('member Membership screen', () => {
  it('an invited membership: named as such, nothing to pay, no renewal date', async () => {
    mockMe = { membership: { planId: 'plan_staging', status: 'active', startedAt: '2026-10-07T10:00:00.000Z', renewsAt: null, activation: 'complimentary' } };
    await show();
    expect(screen.getByText('Invited membership')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByTestId('membership-invited-note')).toHaveTextContent(/There is nothing to pay\./);
    expect(screen.queryByText('Renews')).toBeNull();
    expect(screen.queryByText(/Billing settings/)).toBeNull();
  });

  it('a billed membership keeps the plan name, the renewal date and the billing note', async () => {
    mockMe = { membership: { planId: 'plan_staging', status: 'active', startedAt: '2026-10-07T10:00:00.000Z', renewsAt: '2026-11-06T10:00:00.000Z', activation: 'billing' } };
    await show();
    expect(screen.getAllByText('Membership', { exact: true })).toHaveLength(2); // the title and the plan
    expect(screen.getByText('Renews')).toBeTruthy();
    expect(screen.getByText(/Billing settings/)).toBeTruthy();
    expect(screen.queryByText('Invited membership')).toBeNull();
    expect(screen.queryByTestId('membership-invited-note')).toBeNull();
  });
});
