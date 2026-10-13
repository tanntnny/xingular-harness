import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Several tests start real child processes; the default 5 s is too short on a busy machine.
    testTimeout: 30_000
  }
})
