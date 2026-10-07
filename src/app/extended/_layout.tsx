import { Stack } from 'expo-router';

import { color } from '@/design/tokens';

export default function ExtendedLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }} />;
}
