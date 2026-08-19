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
      junit: './reports/unit/junit.xml',
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
      'scripts/**/*.test.mjs',
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
        'src/renderer/src/components/**/*.{ts,tsx}',
        'electron/main/ipc/**/*.ts',
        'electron/main/ipc/documents.ts',
        'electron/main/ipc/export.ts',
        'electron/main/ipc/search.ts',
        'electron/main/ipc/appdoc.ts',
        'electron/main/handlers/**/*.ts',
        'electron/main/lib/**/*.ts',
        'electron/main/state.ts',
        'electron/main/window.ts',
        'electron/main/i18n.ts',
        'electron/main/menu.ts',
        'electron/main/lifecycle.ts',
        'electron/main/db/database.ts',
        'shared/**/*.ts',
        'scripts/create-pr.mjs',
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
        // No global gate: the project mixes pure logic with DOM / native
        // integration surface, so coverage is enforced per-tier below.
        'src/renderer/src/lib/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'src/renderer/src/store/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'src/renderer/src/i18n/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'src/renderer/src/hooks/**': {
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
        'electron/main/lib/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/ipc/documents.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/ipc/export.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Integration-facing surface (UI components, Electron handlers/IPC, native
        // menu) depends on DOM / native APIs and is validated more loosely.
        // Fallback for any ipc file not listed explicitly above.
        'electron/main/ipc/**': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'electron/main/ipc/search.ts': {
          statements: 92,
          branches: 72,
          functions: 80,
          lines: 92,
        },
        'electron/main/ipc/appdoc.ts': {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
        'electron/main/handlers/**': {
          statements: 85,
          branches: 85,
          functions: 85,
          lines: 85,
        },
        'electron/main/state.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/window.ts': {
          statements: 70,
          branches: 70,
          functions: 70,
          lines: 70,
        },
        'electron/main/db/database.ts': {
          // statements/functions/lines and all reachable branches are fully covered.
          // The unreachable `String(err)` arm of the `err instanceof Error ? … : …`
          // guard (database.ts:39) is excluded from v8 coverage via a `/* v8 ignore
          // next */` comment, because Vitest always wraps a throwing `vi.mock` factory
          // into an Error and a dynamic import can never reject with a non-Error value
          // under test. The gate is therefore held at 100%.
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/i18n.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/menu.ts': {
          statements: 90,
          branches: 60,
          functions: 95,
          lines: 90,
        },
        'electron/main/lifecycle.ts': {
          statements: 90,
          branches: 85,
          functions: 80,
          lines: 90,
        },
        'src/renderer/src/components/**': {
          statements: 90,
          branches: 65,
          functions: 95,
          lines: 95,
        },
        // CI / PR-automation scripts: every branch in create-pr.mjs is now
        // accounted for. Its pure functions (deriveTitle / buildCtx /
        // fillAutoBlocks / replaceAutoBlock / buildBody / buildBodyFor /
        // classifyChange / extractFixes) are fully unit-tested (100%), and the
        // side-effecting runMain (gh/git orchestration, process.exit) plus the
        // direct-invocation guard and the process-executing helpers are wrapped in
        // `/* v8 ignore */` blocks because they cannot be exercised by unit tests.
        // The defensive fallbacks inside fillAutoBlocks are likewise ignored, so
        // the file-level gate is held at 100%.
        'scripts/create-pr.mjs': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
  // Resolve the same "isomorphic" package aliases used by the Worker (aligned with
  // vite.config.ts), ensuring markdownPipeline also uses DOM-free variants in tests
  // (even though tests don't run in the Worker, this keeps parity with the build and
  // avoids potential resolution differences).
  // NOTE: in Vitest v4 `resolve` is no longer a valid field under `test` — it must live
  // at the top level (it is a Vite resolve option, merged into the Vite/Rolldown config),
  // otherwise TS reports TS2769 ("resolve does not exist in type ...") in the IDE.
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
})
