import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Standalone config: Vitest reads this file instead of vite.config.ts,
// to prevent vite-plugin-electron from building the main process/preload during unit tests.
// The renderer subsystem is pure logic (markdownPipeline / sanitize) and needs no React plugin.
export default defineConfig({
  test: {
    environment: 'jsdom',
    // Inline local main-process modules so Vite's SSR transform always processes them instead of
    // externalizing them. On Windows, leaving them external makes vitest mis-resolve their absolute
    // paths and try to load them as untransformed CommonJS ("package D:" SyntaxError), even though
    // tsc confirms the sources are valid ESM. These patterns match the optimizer request ids.
    deps: {
      inline: [
        /electron/,
        /electron\/main/,
        /electron\/main\/ipc/,
        /export\.ts/,
        /documents\.ts/,
        /security/,
        /database/,
        /shared/,
      ],
    },
    include: [
      'src/renderer/src/**/*.test.ts',
      'src/renderer/src/**/*.test.tsx',
      'electron/main/**/*.test.ts',
    ],
    // Report coverage for the ENTIRE project (every source file), not only the files
    // that happened to be imported by a test. This surfaces untested modules instead of
    // hiding them, which is required to reason about true coverage. Integration-only
    // surface (React components, Electron native main, workers, CodeMirror editor, the
    // better-sqlite3 driver) is excluded from the threshold gate because it depends on
    // native APIs / DOM rendering and is validated by other means; the unit-testable
    // logic surface below is held to a high bar.
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
      all: true,
      include: [
        'src/renderer/src/lib/**/*.{ts,tsx}',
        'src/renderer/src/store/**/*.ts',
        'src/renderer/src/i18n/**/*.ts',
        'src/renderer/src/hooks/**/*.{ts,tsx}',
        'electron/main/ipc/documents.ts',
        'electron/main/ipc/export.ts',
        'electron/main/lib/**/*.ts',
        'shared/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/*.d.ts',
        'src/renderer/src/lib/parseClient.ts',
        'src/renderer/src/lib/scrollSync.ts',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
        'electron/main/lib/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'shared/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
    // Resolve the same "isomorphic" package aliases used by the Worker (aligned with
    // vite.config.ts), ensuring markdownPipeline also uses DOM-free variants in tests
    // (even though tests don't run in the Worker, this keeps parity with the build and
    // avoids potential resolution differences).
    resolve: {
      alias: {
        'decode-named-character-reference': fileURLToPath(
          new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url),
        ),
        'hast-util-from-html-isomorphic': fileURLToPath(
          new URL('./node_modules/hast-util-from-html-isomorphic/index.js', import.meta.url),
        ),
      },
    },
  },
})
