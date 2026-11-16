import { defineConfig } from 'vitest/config'

// Measurements on the user's own library (tests/bench): run by hand, not by `npm test`.
export default defineConfig({ test: { include: ['tests/bench/**/*.test.ts'], environment: 'node', testTimeout: 600_000 } })
