import { defineConfig } from 'vitest/config'

// Standalone config: Vitest reads this file instead of vite.config.ts,
// to prevent vite-plugin-electron from building the main process/preload during unit tests.
// The renderer subsystem is pure logic (markdownPipeline / sanitize) and needs no React plugin.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/renderer/src/**/*.test.ts', 'electron/main/**/*.test.ts'],
    // Resolve the same "isomorphic" package aliases used by the Worker (aligned with
    // vite.config.ts), ensuring markdownPipeline also uses DOM-free variants in tests
    // (even though tests don't run in the Worker, this keeps parity with the build and
    // avoids potential resolution differences).
    resolve: {
      alias: {
        'decode-named-character-reference': new URL(
          './node_modules/decode-named-character-reference/index.js',
          import.meta.url,
        ).pathname,
        'hast-util-from-html-isomorphic': new URL(
          './node_modules/hast-util-from-html-isomorphic/index.js',
          import.meta.url,
        ).pathname,
      },
    },
  },
})
