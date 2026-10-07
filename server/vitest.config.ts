import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The shared domain and API contract live in the app's src/ (one source of rules).
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Each test file gets its own database; files run in parallel workers.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
