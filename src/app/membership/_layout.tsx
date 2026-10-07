import { Stack } from 'expo-router';

import { color } from '@/design/tokens';
import { Guard } from '@/navigation/Guard';
import { effectiveZone } from '@/navigation/routes';

/**
 * Membership activation (MEMBERSHIP_PAYMENT_REQUIRED). Approved applicants
 * who continued land here. It is NOT the member product: /member stays closed
 * until the server reports ACTIVE_MEMBER with a live membership (DEC-046).
 */
export default function MembershipLayout() {
  return (
    <Guard allow={(s) => effectiveZone(s) === 'membership'}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }} />
    </Guard>
  );
}
