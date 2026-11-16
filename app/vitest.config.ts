import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/bench/**', '**/node_modules/**'],
    environment: 'node',
    globalSetup: ['tests/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
})
