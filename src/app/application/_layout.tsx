import { Stack } from 'expo-router';

import { color } from '@/design/tokens';

export default function ApplicationLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        contentStyle: { backgroundColor: color.background },
      }}
    />
  );
}
