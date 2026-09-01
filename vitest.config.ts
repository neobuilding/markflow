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
      'electron/preload/**/*.test.ts',
      'actions/create-pr/src/**/*.test.mjs',
    ],
    // Report coverage for the ENTIRE project (every source file), not only the files
    // that happened to be imported by a test. This surfaces untested modules instead of
    // hiding them, which is required to reason about true coverage. Integration-only
    // surface (React components, Electron native main, workers, CodeMirror editor, the
    // native integration surface) is excluded from the threshold gate because it depends on
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
        'electron/preload/**/*.ts',
        'electron/main/ipc/**/*.ts',
        'electron/main/ipc/documents.ts',
        'electron/main/ipc/export.ts',
        'electron/main/ipc/search.ts',
        'electron/main/ipc/appdoc.ts',
        'electron/main/handlers/**/*.ts',
        'electron/main/lib/**/*.ts',
        'electron/main/model/**/*.ts',
        'electron/main/state.ts',
        'electron/main/window.ts',
        'electron/main/i18n.ts',
        'electron/main/menu.ts',
        'electron/main/lifecycle.ts',
        'shared/**/*.ts',
        'actions/create-pr/src/**/*.mjs',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/*.d.ts',
        'src/renderer/src/lib/parseClient.ts',
        'src/renderer/src/lib/scrollSync.ts',
        // actions/create-pr entry/integration surface that cannot be covered by
        // the in-process test runner: cli-render.mjs is launched as a child
        // process (execFile) so the parent's v8 coverage can't instrument it,
        // and index.mjs is the GitHub Action entry point (reads @actions/core
        // and calls process.exit) only executed by the ncc bundle. Both sit at
        // 0% under vitest and are guarded by their own integration/behavioral
        // tests instead of line coverage. The __fixtures__ tree holds test data
        // (sample block plugins), not production code, so it is excluded too.
        'actions/create-pr/src/cli-render.mjs',
        'actions/create-pr/src/index.mjs',
        'actions/create-pr/src/__fixtures__/**',
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
        // All pure-logic IPC handlers are held to 100%; this glob covers
        // documents.ts, export.ts, search.ts, appdoc.ts and any future ipc file.
        'electron/main/ipc/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/handlers/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // In-memory model layer (document store, folder matching, open-folder set,
        // folder watcher). This is the single source of truth after the database
        // layer was removed, so it is held to the same 100% bar as the IPC layer.
        'electron/main/model/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/state.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/window.ts': {
          statements: 100,
          branches: 85,
          functions: 100,
          lines: 100,
        },
        'electron/main/i18n.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Preload layer: the composition root (window.api assembly) is a pure
        // module with no native/IPC logic of its own, and every `api/*.ts`
        // namespace is a thin ipcRenderer wrapper. The whole tree is asserted
        // by the preload test suite (index.test.ts + api/*.test.ts), so it is
        // held to 100%.
        // NOTE: this glob deliberately matches EVERY preload file, mirroring the
        // `coverage.include` entry. A narrower key (index.ts alone) leaves
        // `api/**` measured but UNGATED — that gap let a 50%-branch file sit in
        // the report unnoticed, so keep the two globs in sync.
        'electron/preload/**/*.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/menu.ts': {
          statements: 98,
          branches: 95,
          functions: 100,
          lines: 98,
        },
        'electron/main/lifecycle.ts': {
          statements: 100,
          branches: 85,
          functions: 100,
          lines: 100,
        },
        'src/renderer/src/components/**': {
          statements: 90,
          branches: 65,
          functions: 95,
          lines: 95,
        },
        // CI / PR-automation: the entire actions/create-pr/src tree is covered
        // by unit tests (render / render-template / orchestration / loader / blocks
        // via direct tests; cli-render via a child-process integration test; index
        // and the I/O services via the orchestration tests using fakes). The whole
        // directory is held to 100% so any untested branch in the PR logic surfaces.
        'actions/create-pr/src/**/*.mjs': {
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
