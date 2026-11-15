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
  // No global `testDir` and no `testMatch` override: each project owns its own directory, so the
  // directory IS the only collection boundary (ADR-0034). Playwright's default testMatch picks
  // up `*.e2e.spec.ts`; `e2e/guards/project-ownership.test.ts` asserts that no other test file
  // can slip into those directories.
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
  // Local (many cores) → up to 6 workers; CI (2-core runner) → 1.
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
    // Keep the trace of the run that FAILED, not just the retry. `on-first-retry` recorded the
    // retry (which usually passes) and discarded the only evidence of the original failure —
    // exactly what a flaky e2e leaves behind. `retain-on-failure` keeps a failed run's trace
    // even when a later retry passes, and produces no extra artifact on a green run.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Two layers keep the destructive / timing-sensitive suites safe:
  //
  //   1. PROJECT-level `workers: 1` below caps each such project to ONE worker, so two of its
  //      own specs never run at the same time.
  //   2. BETWEEN projects there is NO such cap: Playwright schedules the projects of ONE
  //      invocation CONCURRENTLY, sharing the global worker budget. Measured 2026-11-05: three
  //      specs in two projects ran on three workers and finished in 12.7s of wall clock while
  //      their own durations summed to 21.1s — they overlapped. (Reading "two 4s specs in two
  //      projects took 8.4s" as "sequential" was wrong: 8.4s is what CONCURRENT execution plus
  //      start-up overhead looks like.)
  //
  // Consequence: a project that must not share the machine needs its OWN invocation. That is
  // exactly the contingency ADR-0027 named: "If Playwright ever parallelised projects, the
  // clipboard and perf suites would need their own invocations; that is the change to make
  // then." `npm run e2e:full` and the CI serial job now do it for `e2e-perf-gate`.
  //
  // Measured 2026-11-05 (same build, same thresholds, firstContentMs vs the 1500ms threshold):
  //
  //   perf-gate inside the invocation that also runs e2e-app : 1602 → RED
  //   perf-gate in its own invocation                       :  712 → GREEN (478/541/647 idle)
  //
  // The threshold is NOT relaxed: the app is still ~3x faster than the frozen 2644ms baseline,
  // so a regression to the pre-Phase-03 behaviour fails loudly either way. What was wrong was
  // the MEASUREMENT, not the app — the gate was timing the machine, not the code.
  //
  // `e2e/guards/e2e-parallelism.test.ts` guards layer 1, the "no --workers override" rule, and
  // the "the perf gate gets its own invocation" rule.
  projects: [
    {
      // No project-level `workers`: e2e-app inherits the global budget above, so the suite
      // parallelises across files on a many-core dev box.
      name: 'e2e-app',
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'app'),
      // Residue gate (see e2e/residue-gate): Playwright runs it automatically AFTER every
      // e2e-app test has finished, and its single test fails the run if any temp directory
      // this run allocated survived. Verified: `--project=e2e-app` and every `--shard=x/4`
      // still schedule the teardown project, so CI's project-filtered commands are covered.
      teardown: 'residue-gate',
    },
    // ── Clipboard: its own project, because it is destructive ────────────────
    //
    // These specs write the REAL system clipboard — Playwright cannot intercept it, and mocking
    // it would defeat the point ("no throw" is not a clipboard write). They overwrite whatever the
    // user copied and put it back afterwards, so only this project may set `clipboardE2e`.
    // The directory IS the boundary: every spec here is a clipboard case (ADR-0034).
    {
      name: 'e2e-clipboard',
      workers: 1, // writes the REAL system clipboard — must never run concurrently
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'clipboard'),
      use: { clipboardE2e: true },
      // Same residue gate as e2e-app; with both teardown: 'residue-gate', the gate runs
      // once AFTER e2e-app AND e2e-clipboard have both finished (it must not run between
      // the two concurrent projects and mis-read the other's still-open directories).
      teardown: 'residue-gate',
    },
    // ── Performance gate: measured in its OWN invocation ─────────────────────
    //
    // This project asserts HARD TIMING thresholds, so it must not share the machine with the
    // other projects' workers — and Playwright runs the projects of one invocation concurrently
    // (see the layer-2 note above). `npm run e2e:full` and the CI serial job therefore run it as
    // a separate `playwright test` invocation.
    {
      name: 'e2e-perf-gate',
      workers: 1, // timing-sensitive thresholds; parallelism would corrupt measurements
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'perf-gate'),
      // The folder-switch stall gate and the large-document Phase-03 gate. The large-document
      // spec prints its full diagnostic report and can freeze a baseline BEFORE asserting, so
      // the gate run keeps every diagnostic capability. Anti-drift comes from shared helpers
      // (perf-fixture.ts), NOT from registering one spec in two projects (ADR-0034).
      timeout: 600_000,
      // Inherits the global retries (1 on CI) so a noisy shared runner cannot
      // turn a one-off scheduling hiccup into a red build.
      teardown: 'residue-gate',
    },
    // ── Performance: one CI gate + one on-demand diagnostic ──────────────────
    //
    // These are separate projects because Playwright runs EVERY project when no
    // --project is given, so `npm run e2e:full` lists the CI projects explicitly
    // (see package.json). The perf GATE runs as its OWN invocation so it is not
    // measured on a machine already loaded by e2e-app; e2e-perf-diag does not.
    // e2e-perf-diag is the fourth project and is deliberately NOT in that list.
    //
    //   e2e-perf-gate  → runs in CI on every PR, has hard thresholds, and gets its
    //                    own `playwright test` invocation (pinned by
    //                    e2e/guards/e2e-parallelism.test.ts).
    //   e2e-perf-diag  → the slow, threshold-free folder-switch diagnostic, run by hand.
    {
      name: 'e2e-perf-diag',
      workers: 1, // diagnostic timings must be measured serially
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'perf-diag'),
      // On-demand only, never run by `npm run e2e:full` or CI. It reloads the app several times
      // and is slow by design. The large-document gate belongs to `e2e-perf-gate` instead:
      // ADR-0034 restores this project's original, disjoint role.
      timeout: 600_000,
      retries: 0,
      // Run by hand, but the same zero-residue contract applies (ADR-0036): launchApp
      // allocates a temp dir, so the gate audits this project too. The `teardown:` link
      // pulls residue-gate in even under --project filtering, so `npm run e2e:perf-diag`
      // needs no explicit --project=residue-gate.
      teardown: 'residue-gate',
    },
    // ── Residue gate: a teardown-only project ───────────────────────────
    //
    // Holds ONE test (e2e/residue-gate/residue-gate.e2e.spec.ts) that fails the run
    // if any temp directory allocated this run survived. It is wired as the `teardown`
    // of every temp-allocating project (e2e-app, e2e-clipboard, e2e-perf-gate, and the
    // on-demand e2e-perf-diag), so Playwright runs it automatically AFTER those
    // projects finish; a failure there is a REAL failed test (recorded by JUnit/CI),
    // not merely a run-level "error not part of any test". Which projects must carry
    // the link is DERIVED by e2e/guards/e2e-parallelism.test.ts from each project's
    // spec imports, not hardcoded there.
    //
    // `retries: 0` is mandatory: the gate CLEANS the leaked directories before asserting,
    // so a retried run would face no leftovers and pass silently. The registry itself is
    // wiped only by global-setup at the START of the next run, not by the gate, so a
    // still-running worker's recordAllocation can never lose its evidence mid-run.
    // This project has NO `dependencies` (Playwright forbids teardown projects from having
    // them). `npm run e2e:app` names it explicitly only to keep the project-name guard's
    // set in lockstep; CI reaches it purely through the `teardown` link above.
    // e2e-parallelism.test.ts pins both the wiring and `retries: 0`.
    {
      name: 'residue-gate',
      workers: 1,
      testDir: join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'residue-gate'),
      retries: 0,
    },
  ],
})
