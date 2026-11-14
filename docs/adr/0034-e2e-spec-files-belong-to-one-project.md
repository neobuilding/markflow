# ADR-0034: every e2e spec file belongs to exactly one Playwright project

- **Status:** Accepted — implemented 2026-11-07
- **Related:** ADR-0027, ADR-0033

## Context

A Playwright **project** is one run configuration, not an owner of files. The set of specs a project
collects is determined by `testDir` (the recursive scan root) plus `testMatch` (a regex matched
against paths relative to that root). A directory name by itself is therefore not an ownership
boundary.

The current config (`playwright.config.ts`) has a global `testDir: e2e/specs` and four projects.
Measured with `npx playwright test --list`:

| Project              | Collected                                                                          |
| -------------------- | ---------------------------------------------------------------------------------- |
| `e2e-app`            | 231 tests / 43 files (all of `e2e/specs`)                                          |
| `e2e-clipboard`      | 87 tests / 6 files — a **subset of the same six specs** `e2e-app` already collects |
| `e2e-perf-gate`      | 2 tests / 2 files under `e2e/perf`                                                 |
| `e2e-perf-diag`      | 2 tests / 2 files under `e2e/perf`                                                 |
| gate + diag together | **4 tests in 3 files** — `large-doc-perf.e2e.spec.ts:102:3` is collected twice     |

Of the 87 clipboard entries only 21 actually write the real system clipboard; the other 66 are
ordinary cases collected a second time. Of the four perf entries, one file is shared between two
projects.

### How the overlap arose (git history)

| Date / commit         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-31 `eafde53b` | Introduced two perf projects, **fully disjoint**: `electron-perf-gate` matched only `switch-perf-gate` (CI gate, hard thresholds, inherits `retries: 1`), `electron-perf` matched only `switch-perf` (threshold-free, `retries: 0`). Comment: "one CI gate + one on-demand diagnostic". Reason for splitting: "Playwright runs EVERY project when no `--project` is given, so `npm run e2e` lists its projects explicitly" — a stable name was needed to keep the slow diagnostic out of CI. |
| 2026-09-20 `b1e5cad4` | Added `large-doc-perf` to the **diagnostic** project only. Still disjoint.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-21 `871e2a05` | Added `large-doc-perf` to the **gate** project too, with "it carries the calibrated thresholds itself, so gate and diagnostic can never drift apart". **This created the overlap.**                                                                                                                                                                                                                                                                                                          |
| 2026-09-23 `bc1fb15e` | Renamed `electron-*` → `e2e-*`; overlap preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The original purpose of `e2e-perf-diag` is explicit in `e2e/perf/switch-perf.e2e.spec.ts:11-12`:
"excluded from `npm run e2e:full` (and therefore from CI) on purpose it reloads the app several
times and is slow by design". Its job is to hold slow, threshold-free, numbers-only diagnostics that
must not slow down CI.

`large-doc-perf` does not match that profile. It has been in CI since 2026-09-21, runs in ~12s, and
asserts five calibrated thresholds (`large-doc-perf.e2e.spec.ts:95-99, 284-306`). The one recorded
CI failure (2026-11-06) was a **code regression**, not runner slowness — the spec says so itself
(`:85-91`: "the fix belongs in the code — that failure came from per-keystroke full-tree
re-renders, not from a slower parse"), fixed by `4abe198b` / ADR-0033. The gate run also produces
the complete diagnostic report, run records and optional baseline freeze _before_ asserting
(`:221-269`), so keeping the spec in the gate loses no diagnostic capability.

Anti-drift does not require sharing a spec file: the folder-switch scenario already uses two
separate specs sharing `e2e/helpers/perf-fixture.ts`, whose header states "Split out of the specs
themselves so the CI gate and the on-demand diagnostic drive the EXACT same code path".

## Decision

1. **One directory per project, one `testDir` per project.** Remove the global `testDir` and every
   `testMatch`; the directory becomes the only boundary. `e2e/app/`, `e2e/clipboard/`,
   `e2e/perf-gate/`, `e2e/perf-diag/`, with the baseline in a neutral `e2e/perf-baselines/`.
2. **Split the six clipboard specs by case.** The 21 cases that write the real system clipboard go
   to `e2e/clipboard/`; the remaining 66 ordinary cases stay in `e2e/app/`. Move the four E9 PNG
   baselines together with `chrome-visual` (Playwright binds the snapshot directory to the spec
   path).
3. **`large-doc-perf.e2e.spec.ts` belongs to `e2e-perf-gate` only.** `e2e-perf-diag` returns to its
   original role: just `switch-perf.e2e.spec.ts`. No file is copied, no `runLargeDocPerf()` helper
   is extracted, no threshold or assertion changes. Manual large-document diagnostics use
   `--project=e2e-perf-gate large-doc-perf` instead of `--project=e2e-perf-diag`.
4. **CI and npm scripts are unchanged.** All three workflow commands select projects by
   `--project=<name>`; no workflow line contains an `e2e/specs` or `e2e/perf` path. `e2e:full`
   keeps its two invocations, and `e2e-perf-gate` keeps its exclusive invocation (ADR-0027).
5. **Test-layer rebalancing (moving 54 of 234 e2e cases down to unit tests) is deferred.** It
   requires a mutation check per case first — revert the production fix, prove the unit test goes
   red, restore, prove green — as required by "Choosing the test layer" and "Regression tests must
   be able to fail" in `docs/agents/testing.md`. It is a separate plan, not part of this change.

   _(Clarified 2026-11-07, without changing the decision: "every `testMatch`" is read as "every
   project-level `testMatch`". A project-level filter would create a second ownership boundary and
   make "which project owns this file" unanswerable from the layout; a global filter that only
   selects the `*.e2e.spec.ts` extension is not an ownership boundary. The guard asserts that
   semantics rather than the absence of a global filter. See Consequences.)_

### Invariants that must not change

`workers: 1` on `e2e-clipboard`, `e2e-perf-gate`, `e2e-perf-diag`; the adaptive global worker
budget; `fullyParallel: false`; the perf gate's own invocation; the five calibrated thresholds and
the "persist report before asserting" order; all `retries` settings; all `../helpers/...` relative
imports (43/43 specs use this form and the new directories remain one level below `e2e/`).

## Considered Options

- **Keep the shared `e2e/perf` directory and rely on `testMatch`:** rejected. It leaves files
  belonging to two projects, is the source of the stale "diagnostic only, no thresholds" comment,
  and provides no structural guard against a future file being collected by the wrong project.
- **Copy `large-doc-perf` into two directories:** rejected. Five threshold constants, calibration
  notes, five assertions and the report/assert ordering would become two sources of truth — exactly
  the drift the project warns against.
- **Two thin entry specs with the same name in two directories, both calling a shared helper:**
  rejected. With the decision that both projects assert the thresholds, the two entries would be
  byte-identical; there is no reason to have two files, and no reason to give them the same name.
  Extracting a helper is also unnecessary work for a single test.
- **Merge the two perf projects into one:** rejected. `retries` differs (`CI ? 1 : 0` vs `0`), and
  merging would force the CI command to list file paths instead of a project name, creating a
  second copy of "which specs belong to CI" that ADR-0027:89-92 explicitly forbids. It would also
  require rewriting three guards in `e2e/guards/e2e-parallelism.test.ts`.
- **Do nothing:** viable — the suite works today — rejected because the overlap makes the two
  project names misleading and blocks the file-ownership rule the rest of the suite needs.

## Consequences

- **Positive:** every spec file is collected by exactly one project. Verifiable with
  `npx playwright test --list --project=e2e-perf-gate --project=e2e-perf-diag`: `4 tests in 3
files` becomes **`3 tests in 3 files`**. `e2e-app` stops re-running 66 ordinary cases, and the
  clipboard project stops carrying cases it does not need.
- **Positive:** `e2e-perf-diag` once again matches its documented role, so
  `playwright.config.ts:143` ("diagnostic only, no thresholds") becomes accurate.
- **Neutral:** the large-document diagnostic is reached through `e2e-perf-gate` instead of
  `e2e-perf-diag`; update the run examples in `large-doc-perf.e2e.spec.ts:36,94` and the docs.
- **Documentation:** ADR-0027:38-39 currently describes both perf projects as asserting hard
  timing thresholds (true while the overlap exists). After implementation, amend that wording; the
  `workers: 1` requirement remains, because a timing measurement is corrupted by concurrency even
  when it has no thresholds. Several stale comments in `playwright.config.ts` and
  `large-doc-perf.e2e.spec.ts` must also be rewritten to describe the current state rather than
  the historical "one spec for both roles is deliberate" rationale.
- **Cost:** moving 43 specs touches hard-coded paths in `e2e/guards/viewports.test.ts:29,161`,
  `e2e/guards/clipboard-project.test.ts:30-32`, `README.md`, `QUICKSTART.md`,
  `docs/agents/testing.md` and the troubleshooting docs. `e2e/guards/e2e-parallelism.test.ts`
  needs no assertion change (it parses command strings, not paths).
- **Implemented 2026-11-07:** after the user clarified that Q1 authorised the §4–§8 rollout, the
  directory split, config, guards, baselines and stale comments were applied. CI workflows and npm
  scripts were left untouched, as decided. Verified: `npx playwright test --list` → 234 tests in
  49 files (app 210/40, clipboard 21/6, perf-gate 2/2, perf-diag 1/1, no overlap); `npm test`
  153 files / 2510 tests passed; `npm run typecheck` and `npm run lint` exit 0.

- **Historical paths left intact:** earlier ADRs (0015, 0024, 0025, 0027) and both troubleshooting
  docs mention `e2e/specs/…` / `e2e/perf/…` as they existed at the time; the troubleshooting pair
  carries a dated historical note pointing here. All **current** guidance (`README.md`,
  `QUICKSTART.md`, `docs/agents/testing.md`, `CONTEXT.md`) and every path reference in
  production/test code uses the new directories.

- **Guard rails (2026-11-07 code review):** `e2e/guards/project-ownership.test.ts` makes "one spec
  file, one project" executable: global `testDir` unset, no project-level `testMatch`, four distinct
  non-nested `testDir`s, and — the central assertion — **every `*.e2e.spec.ts` in the repository is
  collected by exactly one project**. That inventory invariant replaces a head-count: it catches an
  orphaned spec (a file no project collects) and a doubly-collected one (a spec copied into a second
  `testDir`) at once, and it keeps working when specs are added or removed. The same file also keeps
  stray `*.test.ts`/`*.spec.ts` out of the project directories (Playwright's default `testMatch`
  would otherwise collect one), pins `large-doc-perf` to the gate project and `e2e-perf-diag` to the
  threshold-free diagnostic. `e2e/guards/perf-contract.test.ts` pins the five calibrated
  large-document thresholds and the env var that overrides each, asserts that every one of them is
  actually asserted, and keeps the CI workflow free of spec paths while `e2e:full` keeps its two
  invocations. `clipboard-project.test.ts` scans the **other** project directories for a clipboard
  spec, and `viewports.test.ts` scans **every** project's `testDir` rather than only `e2e/app`. All
  three share one recursive scanner (`e2e/guards/scan-specs.ts`) so they cannot disagree about how
  deep to look. Mutation evidence following `docs/agents/testing.md`: copying
  `tooltip.e2e.spec.ts` into `e2e/clipboard/` turned the ownership guard red (`expected 50 to be
49`, `expected 7 to be 6`); removing the probe restored 5 passed / 45 tests.

- **Assertion shape (2026-11-07 third review):** guards were changed from source-text matches and
  head-counts to behaviour/data assertions. The global worker budget is checked against the
  ADR-0027 formula applied to the real `availableParallelism()`; the five thresholds are parsed
  from the gate spec and compared with the ADR-0027 calibration values — they are POLICY constants
  with an independent oracle, not change-detectors, so they stay pinned; the clipboard file count
  became a lower bound; the `e2e-perf-diag` filename allowlist became a narrow "no `expect(` in
  diagnostic specs" semantic check; and the fixture wiring became an exported declaration the guard
  asserts as data. The second-round `eslint.config.mjs` override was reverted (it crossed the
  plan's "eslint unchanged" line) in favour of a file-level disable in `e2e/helpers/fixtures.ts`. The
  guards remain in the vitest suite: an independent policy script would have needed its own tests,
  and coverage was already excluded.

- **Guards that could not fail, fixed (2026-11-07 fourth review):** three assertions had quietly
  stopped checking anything, and two invariants from "Invariants that must not change" had no guard
  at all.
  1. `perf-contract.test.ts`'s "CI is free of spec paths" check matched the OLD directory names
     (`e2e/specs/`, `e2e/perf/`). After this rename it could never match again, so it passed
     whatever the workflow said. It now parses each `playwright test` command's argv and rejects a
     spec path, a project directory, `--grep`, `--only`, or a missing `--project=`.
  2. The global-`testMatch` check looped over an empty array when no filter is declared — which is
     the current arrangement — and therefore asserted nothing. It now asserts the absence
     explicitly.
  3. A string `testMatch` was handed to `new RegExp`, so the legal `'**/*.e2e.spec.ts'` filter threw
     `Nothing to repeat` instead of passing; globs now go through `globToRegExp` in
     `e2e/guards/repo.ts`.
  4. `retries` — listed as an invariant — is now guarded: at most one retry, and `e2e-perf-diag`
     pinned to zero, because a retry on a timing-sensitive project converts a regression into a
     flake that passes on the second attempt.
  5. The clipboard floor counts **cases** (21), not files (6). Deleting a single `test(...)` from a
     spec that stayed in place left every file-level assertion green.

  `repo.ts` additionally absorbs the `ROOT` / `repoSource` / `e2e:full` parsing that three guards
  had duplicated, and `isAsserted` stopped accepting a bare mention of a constant in a failure
  message as proof that it is compared.

- **The remaining invariants got executable checks (2026-11-08):** the three entries in
  "Invariants that must not change" that had no guard — "persist report before asserting", the
  frozen baseline file, and every `../helpers/...` import — now have one each. The worker-budget
  assertion was replaced too: its old expectation restated the config's own formula (and cited
  ADR-0027 for `- 2` while that decision records `- 1`), so it could never catch a wrong formula.
  The guard now pins relations whose oracle is the host's real `availableParallelism()`.

- **The destructive clipboard lifecycle has one owner (2026-11-07 code review):** the gate, the
  launch, the snapshot, the restore and the close live in the `clipboardApp` fixture in
  `e2e/helpers/fixtures.ts`, not in the six specs. Each spec takes the app from that fixture. The
  six copies had already drifted apart — three skipped before launching the app, three launched
  first and snapshotted conditionally — and a copy that forgets the restore leaves the user's
  clipboard holding a test payload. The fixture restores in a `finally`, so a failing test still
  puts the clipboard back. `test.skip()` inside a fixture was verified to mark the test **skipped**
  (not failed) with the option off, and the skip happens before the app is launched, so a project
  that may not write the clipboard never starts the app at all.

- **What "the directory is the boundary" means precisely (2026-11-07 code review):** the _ownership_
  boundary is the directory, which is why no project may set a `testMatch` — a project-level filter
  would make "which project owns this file" unanswerable from the layout. The _extension_ filter is
  a separate concern: the config may carry one global `testMatch` that only selects `*.e2e.spec.ts`,
  and the ownership guard accepts that (it asserts the filter's semantics, not its absence), while
  the current config relies on Playwright's default matching and keeps the stray-file assertion as
  the safety net.
