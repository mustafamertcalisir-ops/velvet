import { Stack } from 'expo-router';

import { color } from '@/design/tokens';
import { useReducedMotion } from '@/design/useReducedMotion';
import { canAccessMemberProduct } from '@/domain/admission/access';
import { Guard } from '@/navigation/Guard';
import { getBackend } from '@/services';
import { MemberProvider } from '@/state/member/MemberProvider';

/**
 * The member product boundary. EVERY route under /member is behind this guard:
 * only ACTIVE_MEMBER with a live membership passes (DEC-002). Applicants —
 * including APPROVED ones — are redirected to their application status.
 *
 * The member API enforces the same rule server-side; the member state
 * provider exists only inside this boundary and only in memory (DEC-055).
 */
export default function MemberLayout() {
  const reduced = useReducedMotion();
  return (
    <Guard allow={(s) => canAccessMemberProduct(s.status, s.membership)}>
      <MemberProvider api={getBackend().member}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }}>
          <Stack.Screen name="index" options={{ animation: reduced ? 'none' : 'fade' }} />
          <Stack.Screen name="dating-setup" />
          <Stack.Screen name="confirm" options={{ animation: reduced ? 'none' : 'fade' }} />
          <Stack.Screen name="(tabs)" options={{ animation: reduced ? 'none' : 'fade', gestureEnabled: false }} />
          {/* The profile opens from the photograph already on screen: a fade keeps it continuous. */}
          <Stack.Screen name="profile/[id]" options={{ animation: reduced ? 'none' : 'fade' }} />
          <Stack.Screen name="match/[id]" options={{ animation: reduced ? 'none' : 'fade', gestureEnabled: false }} />
          <Stack.Screen name="conversation/[id]" />
          <Stack.Screen name="edit-profile" />
          <Stack.Screen name="dating-preferences" />
          <Stack.Screen name="membership" />
          <Stack.Screen name="privacy" />
          <Stack.Screen name="delete-account" options={{ gestureEnabled: false }} />
        </Stack>
      </MemberProvider>
    </Guard>
  );
}
