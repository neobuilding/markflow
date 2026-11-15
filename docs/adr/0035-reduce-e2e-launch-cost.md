# ADR-0035: reduce e2e cost by reusing one Electron instance per spec, not by deleting assertions

- **Status:** Accepted — implemented 2026-11-08
- **Related:** ADR-0023, ADR-0033, ADR-0034

## Context

The expensive part of an e2e case is not its assertions but `launchApp()`: every `test()` used a
`beforeEach` hook that started a fresh Electron process with its own temporary user-data-dir
(`e2e/helpers/launch.ts`). A 2026-11-07 plan had proposed "moving 54 cases down to unit tests" to
thin the expensive layer. Re-evaluation showed that the plan's example/count list and its
"corresponding unit test" column were stale: several named UT files do not exist, keybindings and
case counts had changed, and most e2e cases assert values only a real browser/OS can produce
(real keyboard routing, real DOM geometry and computed styles, real disk writes, the preload
bridge, real CodeMirror, shadow-DOM fonts, lazy IntersectionObserver baking). `docs/agents/testing.md`
("Choosing the test layer") says the thin-expensive-layer rule is about feedback speed, **not a
quota for how many cases a layer holds**, and that a stub supplying an asserted value cannot prove
the real path reached the code. So deleting those cases would lower coverage for a head-count.

## Decision

Reduce `launchApp()` calls instead of removing assertions. Two patterns, both verified by real
Playwright runs (not just `--list`):

1. **Small, mutually independent cases** → one `test()` per file with `test.step()` segments and a
   single `beforeAll`/`afterAll` launch. Steps are ordered so earlier ones cannot pollute later
   ones; where state is shared, helpers are idempotent or explicitly reset it.
2. **Stateful cases** → `test.describe.configure({ mode: 'serial' })`, one shared instance, and a
   `beforeEach` call to `e2e/helpers/reset.ts`. Independent `test()` cases are kept deliberately:
   a failure names one scenario in the report, and `beforeEach` still isolates its state. A single
   mega-test was rejected because the first failing step would abort every later assertion.
   (Serial mode does mean a retry re-runs the whole group from `beforeAll`; that is the accepted
   cost of sharing an instance.)

`resetAppState()` must cover **both processes**: `page.reload()` only rebuilds the renderer (store
flags, panels, modals, view mode), while documents, workspace root, viewport and main-process
monkey patches live outside it. It deletes all documents, clears the workspace root, restores the
standard viewport, restores `dialog.showMessageBox` (confirm spies are installed in the MAIN process
and survive a reload), clears both confirm-call recorders — otherwise a previous case's recorded
call makes a later `.poll(calls.length).toBeGreaterThan(0)` pass vacuously — then reloads. This
reproduces the isolation guarantee `launch.ts` documents for per-test user-data-dirs (notably
avoiding memory-only draft `file_path` collisions).

## Concurrency

`fullyParallel: false` makes cases serial within a file and parallel across files, so a reused
instance is never touched by two workers at once and each file still has its own Electron process
with its own user-data-dir. Serial mode does change failure behaviour: a failing case skips the
rest of its group, and CI's `retries: 1` re-runs the whole group from `beforeAll` (verified with a
temporary probe: hooks stayed paired, no leaked process). Cross-file parallelism is otherwise
unaffected — a full `--project=e2e-app` run passes with merged and unmerged specs interleaved on
the default worker pool.

One pre-existing flake surfaced during those runs: `temp-cleanup.e2e.spec.ts` polls 5s for the app
to delete its own user-data-dir and can time out under load (ADR-0017 declares force-kill residue
best-effort). It passes alone and in repeat full runs; it is not caused by the reuse.

Seven pure-algorithm sidebar-search cases were an exception: they were genuinely redundant with
`electron/main/lib/content-match.test.ts`, `scope-filter.test.ts` and
`electron/main/ipc/search.test.ts` (verified by mutation: disabling the whole-word filter turned
10 UTs red, restoring turned them green). They were deleted, and
`src/renderer/src/components/sidebar/SidebarSearch.search-algorithm.test.tsx` was added to guard
the one thing no other test covered — the component controls reaching the IPC boundary with the
right options. It stubs only `window.api.search.query` and restores `window.api` in `afterEach`.

## Consequences

- `npx playwright test --list`: 234 → 206 tests in 49 files. For the 13 targeted specs,
  `launchApp()` calls drop from 116 to 15 (−87%).
- No assertion was removed except the seven redundant algorithm cases and one duplicated
  "New Document button is visible" case.
- Specs using the serial pattern MUST call `resetAppState` in `beforeEach`. Adding a case that
  sets main-process state without extending the helper will leak into later cases. The
  `test.describe.configure({ mode: 'serial' })` declaration is also mandatory: the shared
  `handle` cannot be used concurrently.
- `vitest.config.ts` and `docs/agents/testing.md` still describe the renderer component surface as
  "covered by Playwright e2e"; that remains true, but the unit suite now also covers the
  component-to-IPC wiring for the Search view.
