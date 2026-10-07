import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Text } from '@/components/Text';
import { Photo } from '@/components/member/Photo';
import { copy } from '@/copy/en';
import { color, layout, radius, space } from '@/design/tokens';
import { clockTime, shortDate } from '@/domain/member/conversation';
import type { ConversationSummary } from '@/services/api/memberTypes';
import { useMember, useMemberActions } from '@/state/member/MemberProvider';

/** Messages: everyone you've been mutually introduced to, most recent first. */
export default function Messages() {
  const insets = useSafeAreaInsets();
  const actions = useMemberActions();
  const list = useMember((s) => s.conversations);
  const [error, setError] = useState(false);
  const t = copy.member.messages;

  const load = useCallback(async () => {
    const res = await actions.loadConversations();
    setError(!res.ok);
  }, [actions]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={styles.root} testID="screen-messages">
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space[6] }]}>
        <Text variant="display" accessibilityRole="header" style={styles.title}>
          {t.title}
        </Text>
        {error && !list ? (
          <View style={styles.state}>
            <Notice message={copy.member.loadFailed} />
            <Button variant="quiet" label={copy.common.retry} onPress={() => void load()} />
          </View>
        ) : list && list.length === 0 ? (
          <View style={styles.state} testID="messages-empty">
            <Text variant="title">{t.emptyHeadline}</Text>
            <Text variant="supporting" tone="secondary" style={styles.emptyBody}>
              {t.emptyBody}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {(list ?? []).map((c, i) => (
              <Row key={c.matchId} c={c} first={i === 0} />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Row({ c, first }: { c: ConversationSummary; first: boolean }) {
  const t = copy.member.messages;
  const now = new Date();
  const at = c.lastMessage?.createdAt ?? c.matchedAt;
  const sameDay = new Date(at).toDateString() === now.toDateString();
  return (
    <Pressable
      onPress={() => router.push(`/member/conversation/${c.matchId}` as Href)}
      accessibilityRole="button"
      accessibilityLabel={`${t.openA11y(c.other.displayName)}${c.unread ? `, ${copy.member.tabs.unread}` : ''}`}
      style={({ pressed }) => [styles.row, !first && styles.divider, pressed && { opacity: 0.7 }]}
      testID={`conversation-row-${c.other.displayName}`}
    >
      <Photo photo={c.other.photo} style={styles.thumb} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text variant="title" numberOfLines={1} style={styles.name} tone={c.unread ? 'primary' : 'primary'}>
            {c.other.displayName}
          </Text>
          <View style={styles.when}>
            {c.unread ? <View style={styles.mark} testID="conversation-unread" /> : null}
            <Text variant="numeral" tone="tertiary">
              {sameDay ? clockTime(at) : shortDate(at, now)}
            </Text>
          </View>
        </View>
        <Text variant="supporting" tone={c.unread ? 'primary' : 'secondary'} numberOfLines={1}>
          {c.lastMessage ? `${c.lastMessage.fromSelf ? t.you : ''}${c.lastMessage.body}` : t.newMatch}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  content: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space[10],
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
  },
  title: { marginBottom: space[6] },
  state: { marginTop: space[6], gap: space[2] },
  emptyBody: { maxWidth: 360 },
  list: {},
  row: { flexDirection: 'row', alignItems: 'center', gap: space[4], paddingVertical: space[3], minHeight: 76 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  thumb: { width: 48, height: 60, borderRadius: radius.control - 2 },
  rowText: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space[3] },
  name: { flexShrink: 1 },
  when: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mark: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.stageMark },
});
