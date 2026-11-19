import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Builds dist/ once for the whole run (the end-to-end tests drive dist/cli.js).
    globalSetup: ['./test/setup/build-dist.ts'],
    // Gives every test file its own throwaway HOME, so no test can see the real one.
    setupFiles: ['./test/setup/isolated-home.ts'],
  },
});
