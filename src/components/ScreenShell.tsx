import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { copy } from '@/copy/en';
import { color, layout, motion, space } from '@/design/tokens';
import { useReducedMotion } from '@/design/useReducedMotion';
import { FocusVisibilityContext, type FieldNode, type FocusVisibility } from './FocusVisibility';
import { Text } from './Text';

export type Progress = { index: number; total: number };

/**
 * Screen frame for every admission step:
 * safe areas, keyboard avoidance, a quiet header (back + folio + hairline
 * progress), scrollable content and a footer that rides above the keyboard.
 */
export function ScreenShell({
  children,
  footer,
  onBack,
  progress,
  headerRight,
  scroll = true,
  testID,
}: {
  children: ReactNode;
  footer?: ReactNode;
  onBack?: () => void;
  progress?: Progress;
  headerRight?: ReactNode;
  scroll?: boolean;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const offset = useRef(0);
  const viewport = useRef(0);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);
  const focusedField = useRef<FieldNode | null>(null);

  const visibility = useMemo<FocusVisibility>(() => {
    const ensure = () => {
      const node = focusedField.current?.() ?? null;
      const content = contentRef.current;
      if (!node || !content || !viewport.current) return;
      node.measureLayout(
        content,
        (_x, y, _w, h) => {
          // Room for the caption or count that sits under a field.
          const margin = space[10];
          const bottom = y + h + margin;
          if (bottom > offset.current + viewport.current) {
            scrollRef.current?.scrollTo({
              y: Math.max(0, bottom - viewport.current),
              animated: !reducedRef.current,
            });
          }
        },
        () => {},
      );
    };
    return {
      focused: (field) => {
        focusedField.current = field;
        // After the keyboard (or a reveal) has changed the layout.
        setTimeout(ensure, 320);
      },
      blurred: (field) => {
        if (focusedField.current === field) focusedField.current = null;
      },
      ensure,
    };
  }, []);

  const body = (
    <View ref={contentRef} style={styles.content}>
      {children}
    </View>
  );
  return (
    <FocusVisibilityContext.Provider value={visibility}>
      <View style={[styles.root, { paddingTop: insets.top }]} testID={testID}>
        <Header onBack={onBack} progress={progress} right={headerRight} />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={insets.top + layout.headerHeight}
        >
          {scroll ? (
            <ScrollView
              ref={scrollRef}
              onScroll={(e) => {
                offset.current = e.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={32}
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height;
                const shrank = viewport.current > 0 && h < viewport.current;
                viewport.current = h;
                if (shrank) visibility.ensure();
              }}
              style={styles.flex}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              showsVerticalScrollIndicator={false}
            >
              {body}
            </ScrollView>
          ) : (
            <View style={[styles.flex, styles.scrollContent]}>{body}</View>
          )}
          {footer ? (
            <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space[4]) }]}>
              <View style={styles.footerInner}>{footer}</View>
            </View>
          ) : (
            <View style={{ height: insets.bottom }} />
          )}
        </KeyboardAvoidingView>
      </View>
    </FocusVisibilityContext.Provider>
  );
}

function Header({ onBack, progress, right }: { onBack?: () => void; progress?: Progress; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        {onBack ? <BackButton onPress={onBack} /> : <View style={styles.backPlaceholder} />}
        <View style={styles.headerRight}>
          {right}
          {progress ? (
            <Text
              variant="numeral"
              tone="secondary"
              accessibilityLabel={copy.common.stepOfA11y(progress.index + 1, progress.total)}
              testID="progress-folio"
            >
              {copy.common.stepOf(progress.index + 1, progress.total)}
            </Text>
          ) : null}
        </View>
      </View>
      {progress ? <ProgressHairline progress={progress} /> : null}
    </View>
  );
}

function ProgressHairline({ progress }: { progress: Progress }) {
  const reduced = useReducedMotion();
  const target = (progress.index + 1) / progress.total;
  const [value] = useState(() => new Animated.Value(Math.max(0, progress.index / progress.total)));
  useEffect(() => {
    if (reduced) {
      value.setValue(target);
      return;
    }
    Animated.timing(value, {
      toValue: target,
      duration: motion.considered,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [target, reduced, value]);
  return (
    <View style={styles.track} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Animated.View
        style={[
          styles.fill,
          {
            width: value.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
          },
        ]}
      />
    </View>
  );
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={copy.common.back}
      hitSlop={8}
      style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}
      testID="back-button"
    >
      <View style={styles.chevron} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  flex: { flex: 1 },
  header: { height: layout.headerHeight, justifyContent: 'flex-end' },
  headerRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter - 4,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[4],
    paddingRight: 4,
  },
  backPlaceholder: {
    width: layout.minTouchTarget,
    height: layout.minTouchTarget,
  },
  back: {
    width: layout.minTouchTarget,
    height: layout.minTouchTarget,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingLeft: 6,
  },
  chevron: {
    width: 11,
    height: 11,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: color.text,
    transform: [{ rotate: '45deg' }],
    marginLeft: 4,
  },
  track: {
    height: 2,
    borderRadius: 1,
    backgroundColor: color.hairline,
    marginHorizontal: layout.gutter,
    overflow: 'hidden',
  },
  fill: { height: 2, borderRadius: 1, backgroundColor: color.smoke },
  scrollContent: { flexGrow: 1 },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: layout.maxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: layout.gutter,
    paddingTop: space[8],
    paddingBottom: space[8],
  },
  footer: {
    paddingTop: space[3],
    paddingHorizontal: layout.gutter,
    backgroundColor: color.background,
  },
  footerInner: {
    width: '100%',
    maxWidth: layout.maxContentWidth,
    alignSelf: 'center',
    gap: space[2],
  },
});
