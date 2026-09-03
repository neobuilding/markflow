// playwright.config.ts
// End-to-end tests for the MarkFlow Electron app.
//
// These tests launch the REAL Electron application and drive its actual
// renderer via Playwright, exercising the full stack:
//   main process (dist-electron) ↔ preload ↔ React renderer.
//
// Run mode: DEV. The shared launch helper (e2e/helpers/launch.ts) starts a
// Vite dev server (renders the real React app over http://localhost:5174) and
// launches Electron with VITE_DEV_SERVER_URL set, so the main process loads
// the renderer from the dev server. This avoids the file:// blank-screen
// problem that occurs when launching the built main entry directly (where
// app.getAppPath() resolves to dist-electron/ and the renderer path is wrong).
//
// Run:
//   npm run e2e   # auto-starts Vite + Electron, runs e2e specs
import { defineConfig } from '@playwright/test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'specs'),
  testMatch: /.*\.e2e\.spec\.ts/,
  fullyParallel: false, // Electron app is a single shared instance per worker
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one Electron app at a time keeps the single-instance lock happy
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

  projects: [
    {
      name: 'electron-app',
    },
    // ── Performance: one CI gate + one on-demand diagnostic ──────────────────
    //
    // These are separate projects because Playwright runs EVERY project when no
    // --project is given, so `npm run e2e` lists its projects explicitly
    // (see package.json): electron-app + electron-perf-gate.
    //
    //   electron-perf-gate  → runs in CI on every PR, has hard thresholds.
    //   electron-perf       → diagnostic only, no thresholds, run by hand.
    {
      name: 'electron-perf-gate',
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'perf'),
      testMatch: /switch-perf-gate\.e2e\.spec\.ts$/,
      timeout: 600_000,
      // Inherits the global retries (1 on CI) so a noisy shared runner cannot
      // turn a one-off scheduling hiccup into a red build.
    },
    {
      name: 'electron-perf',
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'perf'),
      testMatch: /switch-perf\.e2e\.spec\.ts$/,
      timeout: 600_000,
      retries: 0,
    },
  ],
})
