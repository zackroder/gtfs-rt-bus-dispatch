import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Server engine tests run in node; the web has pure utils (routeColor) testable in the
    // same environment until browser-level component infra exists.
    include: ['server/src/**/*.test.ts', 'web/src/**/*.test.ts'],
    environment: 'node',
  },
});
