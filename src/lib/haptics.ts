import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Quiet physical confirmation. Never a reward loop: one light tap for a
 * like, one success notification for a mutual match, nothing else. Fails
 * silently where haptics are unavailable (web, some Android devices).
 */
export const haptics = {
  light() {
    if (Platform.OS === 'web') return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  },
  success() {
    if (Platform.OS === 'web') return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  },
};
