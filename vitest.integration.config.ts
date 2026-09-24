import { defineConfig } from 'vitest/config'

// Dedicated config for the action's end-to-end / integration spec
// (`e2e/integration/cli-render.integration.mjs`). That spec launches the real
// `actions/create-pr/src/cli-render.mjs` as a child process against the real
// repository PR template and the real block plugins, so it is deliberately kept
// OUT of the in-process unit suite and the 100% coverage gate (cli-render.mjs
// runs in a child process beyond the parent's v8 instrumentation).
//
// Run it on demand:
//   npm run test:integration
// or directly:
//   node --experimental-vm-modules node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
    include: ['e2e/integration/**/*.integration.mjs'],
    // Coverage is not meaningful here: the CLI runs in a child process outside
    // the parent's v8 instrumentation, so the provider is disabled.
    coverage: { enabled: false },
  },
})
