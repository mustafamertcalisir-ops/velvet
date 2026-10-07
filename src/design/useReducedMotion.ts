import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Tracks the OS "reduce motion" preference (and prefers-reduced-motion on web). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => mounted && setReduced(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

export const nativeDriver = typeof document === 'undefined';
