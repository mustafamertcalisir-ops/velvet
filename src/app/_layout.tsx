import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { color } from '@/design/tokens';
import { fontAssets } from '@/design/typography';
import { useReducedMotion } from '@/design/useReducedMotion';
import { getBackend, getBilling } from '@/services';
import { deviceStorage } from '@/services/storage';
import { AdmissionProvider, createAdmissionStore, useAdmission } from '@/state/admission/AdmissionProvider';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);

  return (
    <SafeAreaProvider style={{ backgroundColor: color.background }}>
      <AdmissionProvider
        createStore={() => createAdmissionStore({ api: getBackend().api, storage: deviceStorage, billing: getBilling() })}
      >
        <StatusBar style="light" />
        <Navigator ready={fontsLoaded || Boolean(fontError)} />
      </AdmissionProvider>
    </SafeAreaProvider>
  );
}

function Navigator({ ready }: { ready: boolean }) {
  const hydrated = useAdmission((s) => s.hydrated);
  const reducedMotion = useReducedMotion();
  const visible = ready && hydrated;

  useEffect(() => {
    if (visible) void SplashScreen.hideAsync().catch(() => undefined);
  }, [visible]);

  if (!visible) return <View style={{ flex: 1, backgroundColor: color.background }} />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: color.background },
        animation: reducedMotion ? 'none' : Platform.OS === 'ios' ? 'default' : 'fade',
        gestureEnabled: true,
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="verify" />
      <Stack.Screen name="apply" />
      <Stack.Screen name="extended" options={{ gestureEnabled: false }} />
      {/* Status replaces the application flow; there is nothing to go back to. */}
      <Stack.Screen name="application" options={{ gestureEnabled: false, animation: reducedMotion ? 'none' : 'fade' }} />
      <Stack.Screen name="member" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
