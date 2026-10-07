import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Chevron, Dots, PlainIconButton } from '@/components/member/Controls';
import { Photo } from '@/components/member/Photo';
import { SafetySheet } from '@/components/member/SafetySheet';
import { copy } from '@/copy/en';
import { color, layout, radius, space } from '@/design/tokens';
import { maxFontScale, type as typeScale } from '@/design/typography';
import {
  clockTime,
  dayLabel,
  groupMessages,
  MESSAGE_MAX,
  normalizeMessage,
  shortDate,
  type ThreadMessage,
} from '@/domain/member/conversation';
import { useMemberActions } from '@/state/member/MemberProvider';
import { useMemberQuery } from '@/state/member/useMemberQuery';

type Outgoing = ThreadMessage & { clientId: string; state: 'sending' | 'failed' };

/**
 * A conversation V1 (DEC-053): text, a composer, day and time grouping,
 * the other member's profile one tap away, and block/report behind "More".
 * No typing indicators, read receipts, reactions, voice or media.
 */
export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const matchId = String(id);
  const insets = useSafeAreaInsets();
  const actions = useMemberActions();
  const conv = useMemberQuery(() => actions.openConversation(matchId), String(matchId));
  const [sent, setSent] = useState<ThreadMessage[]>([]);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [draft, setDraft] = useState('');
  const [closed, setClosed] = useState(false);
  const [safety, setSafety] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const t = copy.member.conversation;
  const now = new Date();

  const v = conv.value;
  const unavailable =
    closed ||
    (conv.status === 'error' && (conv.error.kind === 'match_not_found' || conv.error.kind === 'conversation_forbidden'));

  const thread: ThreadMessage[] = [
    ...(v?.messages ?? []),
    ...sent.filter((m) => !v?.messages.some((x) => x.id === m.id)),
  ];

  const deliver = async (o: Outgoing) => {
    if (!v) return;
    setOutgoing((list) => list.map((x) => (x.clientId === o.clientId ? { ...x, state: 'sending' } : x)));
    const res = await actions.sendMessage(v.conversationId, o.body, o.clientId);
    if (res.ok) {
      setOutgoing((list) => list.filter((x) => x.clientId !== o.clientId));
      setSent((list) => [...list, res.value]);
    } else if (res.error.kind === 'conversation_forbidden' || res.error.kind === 'match_not_found') {
      setOutgoing([]);
      setClosed(true);
    } else {
      setOutgoing((list) => list.map((x) => (x.clientId === o.clientId ? { ...x, state: 'failed' } : x)));
    }
  };

  const send = () => {
    const body = normalizeMessage(draft);
    if (!body || body.length > MESSAGE_MAX || !v) return;
    const clientId = actions.newMessageId();
    const o: Outgoing = { id: clientId, clientId, fromSelf: true, body, createdAt: new Date().toISOString(), state: 'sending' };
    setOutgoing((list) => [...list, o]);
    setDraft('');
    void deliver(o);
  };

  const days = groupMessages(thread);
  const canSend = normalizeMessage(draft).length > 0 && draft.length <= MESSAGE_MAX;
  const other = v?.other;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      testID="screen-conversation"
    >
      <View style={[styles.header, { paddingTop: insets.top + space[1] }]}>
        <PlainIconButton onPress={() => router.back()} label={copy.common.back} testID="conversation-back">
          <Chevron />
        </PlainIconButton>
        {other ? (
          <Pressable
            style={({ pressed }) => [styles.who, pressed && { opacity: 0.7 }]}
            onPress={() => router.push(`/member/profile/${other.memberId}` as Href)}
            accessibilityRole="button"
            accessibilityLabel={t.viewProfile(other.displayName)}
            testID="conversation-profile"
          >
            <Photo photo={other.photo} style={styles.headerPhoto} />
            <Text variant="title" numberOfLines={1} style={styles.headerName}>
              {other.displayName}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.who} />
        )}
        {other && !unavailable ? (
          <PlainIconButton onPress={() => setSafety(true)} label={copy.member.profile.more} testID="conversation-more">
            <Dots />
          </PlainIconButton>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      <ScrollView
        ref={scroll}
        style={styles.flex}
        contentContainerStyle={styles.thread}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        testID="conversation-thread"
      >
        {v ? (
          <View style={styles.opening}>
            <Photo photo={v.other.photo} style={styles.openingPhoto} />
            <Text variant="caption" tone="secondary" style={styles.openingDate}>
              {t.introduced(shortDate(v.matchedAt, now))}
            </Text>
            {thread.length === 0 && outgoing.length === 0 ? (
              <View style={styles.empty} testID="conversation-empty">
                <Text variant="readback" style={styles.emptyLine}>
                  {t.empty}
                </Text>
                <Text variant="caption" tone="tertiary">
                  {t.emptyNote}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {days.map((day) => (
          <View key={day.day} style={styles.day}>
            <Text variant="caption" tone="secondary" style={styles.dayLabel}>
              {dayLabel(day.day, now, { today: t.today, yesterday: t.yesterday })}
            </Text>
            {day.runs.map((run) => (
              <View key={run.messages[0]!.id} style={[styles.run, run.fromSelf ? styles.runSelf : styles.runOther]}>
                {run.messages.map((m) => (
                  <Bubble key={m.id} fromSelf={run.fromSelf} body={m.body} />
                ))}
                <Text variant="caption" tone="tertiary" style={styles.time}>
                  {clockTime(run.messages[run.messages.length - 1]!.createdAt)}
                </Text>
              </View>
            ))}
          </View>
        ))}

        {outgoing.map((o) => (
          <View key={o.clientId} style={[styles.run, styles.runSelf]}>
            <Pressable
              disabled={o.state !== 'failed'}
              onPress={() => void deliver(o)}
              accessibilityRole={o.state === 'failed' ? 'button' : undefined}
              accessibilityHint={o.state === 'failed' ? t.failed : undefined}
              style={{ opacity: o.state === 'sending' ? 0.6 : 1 }}
              testID={o.state === 'failed' ? 'message-failed' : 'message-sending'}
            >
              <Bubble fromSelf body={o.body} />
              {o.state === 'failed' ? (
                <Text variant="caption" tone="error" style={styles.time}>
                  {t.failed}
                </Text>
              ) : null}
            </Pressable>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, space[3]) }]}>
        {unavailable ? (
          <View style={styles.closed} testID="conversation-closed">
            <Text variant="supporting" tone="secondary">
              {t.closed}
            </Text>
            <Button variant="quiet" label={copy.common.back} onPress={() => router.back()} />
          </View>
        ) : (
          <View style={styles.composerRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={t.placeholder}
              placeholderTextColor={color.textTertiary}
              multiline
              {...(Platform.OS === 'web' ? ({ rows: 1 } as object) : null)}
              maxLength={MESSAGE_MAX + 200}
              style={styles.input}
              selectionColor={color.selection}
              cursorColor={color.caret}
              accessibilityLabel={t.placeholder}
              maxFontSizeMultiplier={maxFontScale.body}
              editable={Boolean(v)}
              testID="composer-input"
            />
            <Pressable
              onPress={send}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel={t.send}
              accessibilityState={{ disabled: !canSend }}
              style={({ pressed }) => [styles.send, pressed && { opacity: 0.6 }]}
              testID="composer-send"
            >
              <Text variant="button" tone={canSend ? 'primary' : 'tertiary'}>
                {t.send}
              </Text>
            </Pressable>
          </View>
        )}
        {draft.length > MESSAGE_MAX ? (
          <Text variant="caption" tone="error" style={styles.tooLong}>
            {t.tooLong}
          </Text>
        ) : null}
      </View>

      {other ? (
        <SafetySheet
          visible={safety}
          onClose={() => setSafety(false)}
          memberId={other.memberId}
          name={other.displayName}
          context="conversation"
          conversationId={v?.conversationId ?? null}
          onBlocked={() => router.navigate('/member/messages' as Href)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function Bubble({ fromSelf, body }: { fromSelf: boolean; body: string }) {
  return (
    <View style={[styles.bubble, fromSelf ? styles.bubbleSelf : styles.bubbleOther]} testID={fromSelf ? 'message-self' : 'message-other'}>
      <Text variant="body" selectable>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[2],
    paddingBottom: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 },
  headerPhoto: { width: 32, height: 40, borderRadius: 8 },
  headerName: { flexShrink: 1 },
  headerSpacer: { width: 44 },
  thread: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space[4],
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
    flexGrow: 1,
  },
  opening: { alignItems: 'center', paddingTop: space[8], paddingBottom: space[4] },
  openingPhoto: { width: 88, height: 112, borderRadius: radius.control },
  openingDate: { marginTop: space[3] },
  empty: { marginTop: space[8], alignItems: 'center', gap: space[2] },
  emptyLine: { textAlign: 'center' },
  day: { marginTop: space[4] },
  dayLabel: { textAlign: 'center', marginBottom: space[3] },
  run: { marginBottom: space[3], maxWidth: '82%', gap: 3 },
  runSelf: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  runOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: { paddingHorizontal: space[4], paddingVertical: 10, borderRadius: radius.medium },
  bubbleSelf: { backgroundColor: 'rgba(243,240,234,0.13)' },
  bubbleOther: { backgroundColor: color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairline },
  time: { marginTop: 2 },
  composer: {
    paddingTop: space[2],
    paddingHorizontal: layout.gutter - space[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space[2],
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter,
    alignSelf: 'center',
  },
  input: {
    ...typeScale.body,
    flex: 1,
    color: color.text,
    minHeight: 44,
    maxHeight: 132,
    paddingHorizontal: space[4],
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: radius.field,
    backgroundColor: color.surface,
  },
  send: { minHeight: 44, minWidth: 56, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[2] },
  closed: { alignItems: 'flex-start', paddingHorizontal: space[2], paddingVertical: space[2] },
  tooLong: { marginTop: space[1], paddingHorizontal: space[2] },
});
