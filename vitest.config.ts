import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Standalone config: Vitest reads this file instead of vite.config.ts,
// to prevent vite-plugin-electron from building the main process/preload during unit tests.
// The renderer subsystem is pure logic (markdownPipeline / sanitize) and needs no React plugin.
export default defineConfig({
  test: {
    environment: 'jsdom',
    // Polyfill Range.getClientRects / getBoundingClientRect for CodeMirror under
    // jsdom, which otherwise throws unhandled "getClientRects is not a function"
    // errors from its async layout measurement.
    setupFiles: ['./test-setup.ts'],
    // Emit a JUnit XML report so CI can render test results in the Checks/PR UI
    // (dorny/test-reporter) and in GitHub's native test summary.
    // NOTE: vitest v4 (rolldown/oxc) cannot resolve reporter entries written as
    // `[name, options]` arrays — it throws `StringExpected` when loading the custom
    // reporter module. Use the plural `reporters` field with plain string names and
    // configure per-reporter output via the `outputFile` map instead.
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './coverage/junit.xml',
    },
    // NOTE: vitest v4 removed `test.deps.inline` (and `test.deps.external`). In v3 these regex
    // patterns forced local main-process modules to be inlined through Vite's SSR transform instead
    // of being externalized as CommonJS — on Windows externalizing made vitest mis-resolve absolute
    // paths and try to load them as untransformed CJS ("package D:" SyntaxError). v4's rolldown-based
    // module runner transforms project sources by default, so this workaround is no longer needed.
    // If a module must be excluded from dependency pre-bundling, use `deps.optimizer` instead.
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
      // NOTE: vitest v4 removed `coverage.all`. The provider now automatically includes untested
      // files matched by `include` whenever a full test run executes (i.e. not a per-file rerun),
      // so the previous `all: true` behavior is preserved by the `include` list below.
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
