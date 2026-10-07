/**
 * Build variants (DEC-078). app.json is the base; APP_VARIANT=staging gives
 * staging builds their own app identity so they install BESIDE a production
 * build and can never be mistaken for it on the home screen:
 *   iOS bundle id / Android package  …membership.staging
 *   name                             "<name> Staging"
 *   URL scheme                       <scheme>-staging
 * The API a build talks to is EXPO_PUBLIC_API_URL; the in-app channel is
 * EXPO_PUBLIC_RELEASE_CHANNEL (src/config.ts). eas.json's `staging` profile
 * sets all three; scripts/check-release-bundle.mjs verifies the result.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  if (process.env.APP_VARIANT !== 'staging') return base;
  return {
    ...base,
    name: `${base.name} Staging`,
    scheme: `${String(base.scheme)}-staging`,
    ios: { ...base.ios, bundleIdentifier: `${base.ios?.bundleIdentifier}.staging` },
    android: { ...base.android, package: `${base.android?.package}.staging` },
  };
};
