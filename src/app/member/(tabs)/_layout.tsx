import { Redirect, Tabs } from 'expo-router';
import { useEffect } from 'react';

import { MemberTabBar } from '@/components/member/MemberTabBar';
import { copy } from '@/copy/en';
import { color } from '@/design/tokens';
import { useReducedMotion } from '@/design/useReducedMotion';
import { useMember, useMemberActions } from '@/state/member/MemberProvider';

/**
 * Home · Messages · You — the smallest member navigation (DEC-056).
 * Further places (Places, Travel, Directory) become further tabs later.
 * The tabs open only after the profile has been confirmed.
 */
export default function MemberTabs() {
  const reduced = useReducedMotion();
  const actions = useMemberActions();
  const me = useMember((s) => s.me);

  useEffect(() => {
    if (!me) void actions.loadMe();
    // Messages' "new" mark needs the conversation list; it is cheap and member-only.
    void actions.loadConversations();
  }, [actions, me]);

  if (me && !me.profile.confirmedAt) return <Redirect href="/member" />;

  return (
    <Tabs
      tabBar={(props) => <MemberTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: color.background },
        animation: reduced ? 'none' : 'fade',
      }}
    >
      <Tabs.Screen name="home" options={{ title: copy.member.tabs.home }} />
      <Tabs.Screen name="messages" options={{ title: copy.member.tabs.messages }} />
      <Tabs.Screen name="you" options={{ title: copy.member.tabs.you }} />
    </Tabs>
  );
}
