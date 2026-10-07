import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';

import { copy } from '@/copy/en';
import { color, layout, radius, space } from '@/design/tokens';
import { type as typeScale } from '@/design/typography';
import type { AgeRange } from '@/domain/admission/stage2';
import { Text } from './Text';

/**
 * An age range as two plain numbers, each with a quiet − / + pair — not a
 * slider, no track, no handles to drag. Every value is visible as a numeral;
 * holding a button keeps stepping. For assistive technology each end is one
 * "adjustable" element (swipe up/down to change), announced with its value.
 */
export function AgeRangeField({
  value,
  onChange,
  bounds,
  minSpan,
  testID,
}: {
  value: AgeRange;
  onChange: (next: AgeRange) => void;
  bounds: { min: number; max: number };
  minSpan: number;
  testID?: string;
}) {
  const t = copy.extended.ageRange;
  // The latest value, for hold-to-repeat callbacks that outlive a render.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  const step = (end: 'min' | 'max', delta: number) => {
    const v = latest.current;
    const next =
      end === 'min'
        ? { ...v, min: clamp(v.min + delta, bounds.min, v.max - minSpan) }
        : { ...v, max: clamp(v.max + delta, v.min + minSpan, bounds.max) };
    if (next.min !== v.min || next.max !== v.max) {
      latest.current = next;
      onChange(next);
    }
  };

  return (
    <View testID={testID}>
      <View style={styles.row}>
        <End
          label={t.from}
          a11yName={t.youngest}
          value={value.min}
          canDecrease={value.min > bounds.min}
          canIncrease={value.min < value.max - minSpan}
          onStep={(d) => step('min', d)}
          testID="age-min"
        />
        <View style={styles.dash} />
        <End
          label={t.to}
          a11yName={t.oldest}
          value={value.max}
          canDecrease={value.max > value.min + minSpan}
          canIncrease={value.max < bounds.max}
          onStep={(d) => step('max', d)}
          testID="age-max"
        />
      </View>
      <Text variant="body" style={styles.readback} accessibilityLiveRegion="polite" testID="age-readback">
        {t.readback(value.min, value.max)}
      </Text>
      <Text variant="caption" tone="tertiary" style={styles.limits}>
        {t.limits(bounds.min, bounds.max)}
      </Text>
    </View>
  );
}

function End({
  label,
  a11yName,
  value,
  canDecrease,
  canIncrease,
  onStep,
  testID,
}: {
  label: string;
  a11yName: string;
  value: number;
  canDecrease: boolean;
  canIncrease: boolean;
  onStep: (delta: number) => void;
  testID: string;
}) {
  const t = copy.extended.ageRange;
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'increment' && canIncrease) onStep(1);
    if (e.nativeEvent.actionName === 'decrement' && canDecrease) onStep(-1);
  };
  return (
    <View style={styles.end}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={a11yName}
        accessibilityValue={{ text: String(value) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onAction}
      >
        <Text variant="label" tone="secondary">
          {label}
        </Text>
        <Text style={styles.numeral} testID={`${testID}-value`}>
          {value}
        </Text>
      </View>
      <View style={styles.steppers}>
        <StepButton glyph="minus" disabled={!canDecrease} onStep={() => onStep(-1)} label={t.decrease(a11yName)} testID={`${testID}-decrease`} />
        <StepButton glyph="plus" disabled={!canIncrease} onStep={() => onStep(1)} label={t.increase(a11yName)} testID={`${testID}-increase`} />
      </View>
    </View>
  );
}

/** Tap steps once; holding repeats after a short pause. */
function StepButton({
  glyph,
  disabled,
  onStep,
  label,
  testID,
}: {
  glyph: 'minus' | 'plus';
  disabled: boolean;
  onStep: () => void;
  label: string;
  testID: string;
}) {
  const timers = useRef<{ wait?: ReturnType<typeof setTimeout>; repeat?: ReturnType<typeof setInterval> }>({});
  const stop = () => {
    clearTimeout(timers.current.wait);
    clearInterval(timers.current.repeat);
    timers.current = {};
  };
  useEffect(() => stop, []);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);

  return (
    <Pressable
      onPress={disabled ? undefined : onStep}
      onLongPress={
        disabled
          ? undefined
          : () => {
              stop();
              timers.current.repeat = setInterval(onStep, 90);
            }
      }
      delayLongPress={380}
      onPressOut={stop}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      // The adjustable value above already serves screen readers; avoid duplicates.
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={({ pressed }) => [styles.step, disabled && styles.stepDisabled, pressed && !disabled && styles.stepPressed]}
      testID={testID}
    >
      <View style={styles.glyphH} />
      {glyph === 'plus' ? <View style={styles.glyphV} /> : null}
    </Pressable>
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  end: { flex: 1 },
  dash: { width: 20, height: 1.5, backgroundColor: color.hairlineStrong, marginTop: 52, marginHorizontal: space[4] },
  numeral: {
    ...(typeScale.heroAnswer as object),
    fontSize: 48,
    lineHeight: 56,
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
    color: color.text,
    marginTop: space[1],
  },
  steppers: { flexDirection: 'row', gap: space[2], marginTop: space[3] },
  step: {
    width: layout.minTouchTarget + 4,
    height: layout.minTouchTarget,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepPressed: { backgroundColor: color.surface },
  stepDisabled: { opacity: 0.32 },
  glyphH: { position: 'absolute', width: 14, height: 1.5, backgroundColor: color.text },
  glyphV: { position: 'absolute', width: 1.5, height: 14, backgroundColor: color.text },
  readback: { marginTop: space[8] },
  limits: { marginTop: space[2] },
});
