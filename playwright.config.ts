// playwright.config.ts
// End-to-end tests for the MarkFlow Electron app.
//
// These tests launch the REAL Electron application and drive its actual
// renderer via Playwright, exercising the full stack:
//   main process (dist/electron) ↔ preload ↔ React renderer.
//
// Run mode: DEV. The shared launch helper (e2e/helpers/launch.ts) starts a
// Vite dev server (renders the real React app over http://localhost:5174) and
// launches Electron with VITE_DEV_SERVER_URL set, so the main process loads
// the renderer from the dev server. This avoids the file:// blank-screen
// problem that occurs when launching the built main entry directly (where
// app.getAppPath() resolves to dist/electron/ and the renderer path is wrong).
//
// Run:
//   npm run e2e:full   # auto-starts Vite + Electron, runs e2e specs
import { defineConfig } from '@playwright/test'
import { availableParallelism } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClipboardOptions } from './e2e/helpers/fixtures'

export default defineConfig<ClipboardOptions>({
  testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'specs'),
  testMatch: /.*\.e2e\.spec\.ts/,
  // Serial WITHIN a file (a spec's tests run in order in one worker), but
  // PARALLEL ACROSS files via the worker pool below. Each test still launches
  // its own Electron instance with a private --user-data-dir (e2e/helpers/launch.ts),
  // so cross-test state never leaks — and in DEV mode the single-instance lock is
  // never acquired (electron/main/index.ts: app.isPackaged ? requestSingleInstanceLock() : true),
  // so the old "single shared instance / single-instance lock" rationale for workers:1
  // was obsolete. See ADR-0027.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Concurrency budget = (available CPU parallelism − 2), capped at 8, never below 1.
  // `os.availableParallelism()` (Node ≥ 18.14; the repo's toolchain requires Node ≥ 20.19)
  // honours the CPU affinity mask AND the container's cgroup CPU quota, so it stays honest on a
  // CI runner that is limited to fewer cores than its host — `os.cpus().length` would report
  // the HOST's core count there and over-subscribe the runner.
  // Local (many cores) → up to 7 workers; CI (2-core runner) → 2.
  // The clipboard / perf projects below override this to 1: they are destructive
  // (real system clipboard) or timing-sensitive (perf thresholds).
  workers: Math.max(1, Math.min(availableParallelism(), 8) - 2),
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never' }],
        ['list'],
        ['junit', { outputFile: 'reports/e2e/junit.xml', flatten: true }],
      ]
    : 'list',
  timeout: 90_000, // first launch also compiles the main process via Vite
  expect: { timeout: 10_000 },

  // The global setup starts ONE shared Vite dev server and writes its URL to
  // e2e/.dev-url; every spec launches its own Electron instance against it.
  globalSetup: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'global-setup.ts'),

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Two layers keep the destructive / timing-sensitive suites safe:
  //
  //   1. PROJECT-level `workers: 1` below caps each such project to ONE worker, so two of its
  //      own specs never run at the same time.
  //   2. Playwright runs PROJECTS sequentially (each project is its own phase), so the clipboard
  //      and perf projects never share the machine with e2e-app's Electron instances — which is
  //      what keeps the real system clipboard and the perf thresholds uncontended. Verified
  //      empirically: two 4s specs in two projects took 8.4s of wall clock, not 4s.
  //
  // If Playwright ever parallelised projects, layer 2 would disappear silently; the remedy
  // would then be to run the clipboard / perf projects in their OWN invocations.
  // `e2e/guards/e2e-parallelism.test.ts` guards layer 1 and the "no --workers override" rule;
  // this comment guards layer 2, which no unit test can observe.
  projects: [
    {
      // No project-level `workers`: e2e-app inherits the global budget above, so the suite
      // parallelises across files on a many-core dev box.
      name: 'e2e-app',
    },
    // ── Clipboard: its own project, because it is destructive ────────────────
    //
    // These six specs write the REAL system clipboard — Playwright cannot intercept it, and mocking
    // it would defeat the point ("no throw" is not a clipboard write). They overwrite whatever the
    // user copied and put it back afterwards, so a plain `npm run e2e:app` must not run them: they
    // read the `clipboardE2e` option (e2e/helpers/fixtures.ts), which only this project sets.
    // `npm run e2e:full` includes it, so CI runs them for real.
    {
      name: 'e2e-clipboard',
      workers: 1, // writes the REAL system clipboard — must never run concurrently
      use: { clipboardE2e: true },
      testMatch:
        /(?:select-all-copy-fidelity|pane-toolbars|preload-contract|formula-copy-image|copy-once-no-drop-diagrams|context-menu)\.e2e\.spec\.ts$/,
    },
    // ── Performance: one CI gate + one on-demand diagnostic ──────────────────
    //
    // These are separate projects because Playwright runs EVERY project when no
    // --project is given, so `npm run e2e:full` names the three CI projects explicitly
    // (see package.json): e2e-app + e2e-clipboard + e2e-perf-gate, in ONE playwright run.
    // e2e-perf-diag is the fourth project and is deliberately NOT in that list.
    //
    //   e2e-perf-gate  → runs in CI on every PR, has hard thresholds.
    //   e2e-perf-diag  → diagnostic only, no thresholds, run by hand.
    {
      name: 'e2e-perf-gate',
      workers: 1, // timing-sensitive thresholds; parallelism would corrupt measurements
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'perf'),
      // Both gates in one project: the chokidar folder-switch gate and the large-document
      // gate. The large-document one IS the diagnostic spec (large-doc-perf) — it carries
      // the calibrated thresholds itself, so gate and diagnostic can never drift apart
      // (the same reason perf-fixture.ts is shared by switch-perf and its gate).
      testMatch: /(?:switch-perf-gate|large-doc-perf)\.e2e\.spec\.ts$/,
      timeout: 600_000,
      // Inherits the global retries (1 on CI) so a noisy shared runner cannot
      // turn a one-off scheduling hiccup into a red build.
    },
    {
      name: 'e2e-perf-diag',
      workers: 1, // diagnostic timings must be measured serially
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'perf'),
      // On-demand diagnostics, never run by `npm run e2e:full` (which composes its
      // scripts explicitly): the folder-switch scenario and the large-document scenario
      // the Phase-03 candidates (mermaid lazy-render / image size / block incremental)
      // are judged against. `e2e-perf-gate` is excluded on purpose — that one IS a CI
      // gate and belongs to the e2e-perf-gate project.
      testMatch: /(?:switch|large-doc)-perf\.e2e\.spec\.ts$/,
      timeout: 600_000,
      retries: 0,
    },
  ],
})
