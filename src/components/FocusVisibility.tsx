import { createContext, useContext } from 'react';
import type { View } from 'react-native';

type Measurable = Pick<View, 'measureLayout'>;

/**
 * Keeps the focused field visible inside a ScreenShell when the visible area
 * shrinks (the keyboard opens, a field is revealed further down). Fields
 * report focus and blur; the shell scrolls only when the field's lower edge
 * would otherwise sit behind the footer.
 */
/** A getter, not a node: an autofocused field reports focus before its ref is attached. */
export type FieldNode = () => Measurable | null;

export type FocusVisibility = {
  focused: (field: FieldNode) => void;
  blurred: (field: FieldNode) => void;
  /** Re-check after the visible area changed. */
  ensure: () => void;
};

export const FocusVisibilityContext = createContext<FocusVisibility | null>(null);

export function useFocusVisibility(): FocusVisibility | null {
  return useContext(FocusVisibilityContext);
}
