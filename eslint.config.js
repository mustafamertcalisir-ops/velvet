// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'dist-native/*', 'dist-prod/*', 'e2e/*', '.expo/*', 'server/*', 'src/domain/geo/countries.generated.ts'],
  },
]);
