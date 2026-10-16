import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'tests/workers/**', 'node_modules/**', 'dist/**'],
    globals: false,
  },
});
