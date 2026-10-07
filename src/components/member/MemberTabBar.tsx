import type { BottomTabBarProps } from 'expo-router/tabs';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, layout, space } from '@/design/tokens';
import { useMember } from '@/state/member/MemberProvider';

/**
 * The member navigation: three words, no icons (DEC-056). The current place
 * steps forward in Pearl with a short rule above it; the others sit in Smoke.
 * A single small Pomegranate mark beside "Messages" means something new —
 * the only use of the signature colour in the member product. More places
 * (Places, Travel, Directory) can be added as further tabs later.
 */
export function MemberTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const unread = useMember((s) => s.conversations?.some((c) => c.unread) ?? false);
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space[2]) }]} testID="member-tabs">
      <View style={styles.inner} accessibilityRole="tablist">
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const label = (descriptors[route.key]?.options.title ?? route.name) as string;
          const showMark = route.name === 'messages' && unread && !focused;
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={showMark ? `${label}, ${copy.member.tabs.unread}` : label}
              style={styles.tab}
              testID={`tab-${route.name}`}
            >
              <View style={[styles.rule, focused && styles.ruleOn]} />
              <View style={styles.labelRow}>
                <Text variant="label" tone={focused ? 'primary' : 'secondary'}>
                  {label}
                </Text>
                {showMark ? <View style={styles.mark} testID="tab-messages-unread" /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: color.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  inner: {
    flexDirection: 'row',
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
    paddingHorizontal: space[2],
  },
  tab: { flex: 1, alignItems: 'center', minHeight: 52, paddingBottom: space[2] },
  rule: { width: 16, height: 2, marginBottom: space[3], backgroundColor: 'transparent' },
  ruleOn: { backgroundColor: color.pearl },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mark: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.stageMark },
});
