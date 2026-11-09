# ADR-0036: e2e enforces a zero-residue gate (residue from a clean exit is a defect)

- **Status:** Accepted — implemented 2026-11-09
- **Related:** ADR-0017 (tightened on the e2e side; ADR-0017 itself is unchanged, append-only — see Consequences), ADR-0035

## Context

ADR-0017 declares temp residue **best-effort**: an instance that is force-killed or loses power
may leave its `%TEMP%/markflow-<pid>` directory behind, and chasing that is explicitly out of
scope. That stance is about the **production** binary, where a `SIGKILL` truly runs no code of
ours. It is not a licence for the app to leak on a **clean** exit.

But nothing in the e2e or unit layers _verified_ that the app cleans up after a clean quit. The
owner-removes-its-own-dir path (`will-quit` → `removeOwnTempDir` + `scheduleRemoveAfterExit`) was
only ever smoke-tested; a regression that made it silently no-op would leave directories behind
and **every test would still pass** — exactly the "green while the machine fills up" failure mode
the temp-registry convention in `docs/agents/testing.md` was written to prevent. Two latent
defects made this likely:

1. **Async race in `will-quit`.** `lifecycle.ts` awaited `stopFolderWatching()` _before_ the temp
   cleanup. If the process exited before that `await` settled, the cleanup was skipped entirely.
2. **Timeout was not a failure.** `launch.ts`'s `closeApp()` swallowed its own 10s-quit timeout, so
   an app that hung on quit (never running `will-quit`) was reported as "closed" and the residue it
   left was invisible to CI.

We need a gate that turns "the app leaked after a clean run" into a **real failed test** (a JUnit
`failed`, not a run-level `error`), so CI goes red and the regression cannot ship.

## Decision

Add an e2e **residue gate** that fails the run when the app leaves residue behind after a clean
exit, plus two production-side fixes that make a clean exit actually clean.

### 1. The gate is a Playwright `TestProject.teardown`, not `globalTeardown`

Playwright runs a project's `teardown` spec **after all of that project's tests**, and a failure
there is a genuine test failure in the JUnit/CI report (`1 failed`). A thrown error in
`globalTeardown`, by contrast, produces only `error was not a part of any test` — a run-level
blip that CI can miss. So every temp-allocating project (`e2e-app`, `e2e-clipboard`,
`e2e-perf-gate`, and the on-demand `e2e-perf-diag`, which allocates temp dirs too even though it
runs by hand) lists `teardown: 'residue-gate'`, and `residue-gate` is its own project
(`workers: 1`, `retries: 0`, `testDir: e2e/residue-gate`).

CI's `--shard` splits run each shard in its own VM, so each shard's `residue-gate` inspects only
that VM's `%TEMP%` — no cross-shard contention. **Verified, not assumed**: `playwright test
--project=e2e-app --shard=x/4 --list` lists `[residue-gate]` for all four shards, and the same
holds for `--project=e2e-clipboard`, `--project=e2e-perf-gate`, and `--project=e2e-perf-diag`. A
teardown project is pulled in
by the `teardown:` link even when `--project` filters the primary projects, so CI does not need to
name `residue-gate` explicitly (and `e2e-parallelism.test.ts` forbids adding it to the workflow,
because that guard keeps CI's project list identical to `e2e:full`'s). The wiring itself is pinned
by a contract guard.

### 2. The gate checks a run-scoped residue registry, never a `%TEMP%` scan

The gate must not sweep `%TEMP%/markflow-*` by prefix — that would touch a _live_ instance's
profile (the BUG-1 class ADR-0017 rejected). Instead it verifies only paths **this run
allocated**:

- `e2e/helpers/temp.ts` appends every allocated directory to a per-worker registry file
  `e2e/.residue-registry/<process.pid>.jsonl` (`recordAllocation(dir)`); `mkTempDir` calls it.
  `untrackTempDir` intentionally does **not**, so the gate also
  verifies the app removed directories it was expected to own.
- `global-setup.ts` calls `resetResidueRegistry()` at the start of a run, so a crashed worker's
  stale registry from a previous run never pollutes the current one. The wipe lives in `temp.ts`
  (not inline in setup) so it is a pure, unit-testable part of the same ownership logic. The
  registry is on disk (not just in-memory) so a worker that dies mid-run still leaves an auditable
  allocation list. The gate does **not** delete the registry: doing so raced a still-running
  worker's `recordAllocation` and made a retry face empty bookkeeping. `recordAllocation` creates
  the directory on every write and fails loudly on a write error — an unrecorded allocation would
  otherwise be invisible residue. The write-failure and wipe paths, the "gate never deletes it"
  wiring, and the git-ignore rule are checked by `temp.test.ts` and
  `e2e/guards/residue-registry.test.ts`.
- The `residue-gate` spec reads the registry and waits **one shared deadline** (`RESIDUE_GRACE_MS`,
  derived from the deleter's `DEFER_DELAY_MS + RETRY_GRACE_MS` plus a margin) before declaring a
  path leaked. A per-path grace window would stall the run for `N × grace`; a grace shorter than the
  deleter turns a slow-but-successful delete into a false red.
- The audit logic (`readResidueRegistry` / `findResidue` / `cleanupResidue`), the registry
  bookkeeping (`recordAllocation` / `resetResidueRegistry`) and the harness ownership path
  (`mkTempDir` / `untrackTempDir` / `cleanupTempDirs`) are pure with injectable fs/clock, and are
  unit-tested in `e2e/helpers/temp.test.ts` — including a **deliberately leaked directory being
  reported** (the permanent form of "the gate can go red"), a **loud** write failure, and an
  untracked allocation still being registered. The e2e spec only orchestrates those functions. The
  old pure-fs "harness reclaims its own dirs" e2e case was moved down to that unit suite after a
  mutation check; only the app-owned `will-quit` removal still needs a real Electron quit. This
  keeps the logic at the lowest layer of the test pyramid (`docs/agents/testing.md`, "Choosing the
  test layer"). `e2e/helpers/reset.test.ts` and `e2e/guards/serial-reset.test.ts` extend the same
  rule to the serial-mode reset added by ADR-0035.

### 3. Order inside the gate: record evidence → clean up → assert

The spec captures existence of each registered path **first** (evidence), then removes the leaked
directories, and only **then** asserts on the captured list. This prevents cleanup from overwriting
the evidence before the assertion sees it.

### 4. Production-side fix D1 — synchronous, first cleanup in `will-quit`

`lifecycle.ts` now runs `removeOwnTempDir` + `scheduleRemoveAfterExit` **first and synchronously**,
and awaits `stopFolderWatching()` **afterwards** (pinned by a `toHaveBeenCalledBefore` unit
assertion). The cleanup is therefore already done even if the async watcher-close is cut short by
process exit. `electron/main/lib/temp-cleanup.ts` makes `scheduleRemoveAfterExit` retry the delete
for `RETRY_GRACE_MS` (with `RETRY_INTERVAL_MS` spacing) so a transient `EPERM` from Chromium's
teardown flush no longer strands a directory on Windows. The retry budget starts at the **first
attempt**, not when the deferred script is parsed — otherwise the 2s defer eats the 6s window.
`buildDeleterScript()` is a pure exported function whose retry behaviour is driven in a `vm` by
`temp-cleanup.test.ts`; removing the retry loop turns that test red.

### 5. Production-side fix D2 — a quit timeout is a real failure

`launch.ts`'s `closeApp()` now **throws** when the app fails to quit within the timeout, instead of
returning a "closed" handle. It only force-kills and marks `forceKilled` when the pid is still
alive at timeout; a process that already exited but failed to settle the quit also throws. This
makes a hung or non-cleaning app surface as an e2e failure rather than a silent green. The
`timedOut × alreadyClosed × pidAlive` decision matrix is the exported pure function
`classifyCloseFailure()`, covered exhaustively by `e2e/helpers/launch.test.ts`. Both failure branches
preserve the original error via `Object.assign(new Error(...), { cause })`, the repo-wide idiom
documented in `CONTRIBUTING.md`.

## Consequences

- A clean run that leaves any registered temp directory behind now produces a **failed e2e test**,
  which CI reports as `failed`, satisfying the original requirement (a real failure, not a
  run-level error).
- ADR-0017 is **unchanged** (append-only). Its "residue is best-effort; the platform is the floor"
  stance still governs the **shipped production binary** under abnormal exits (`SIGKILL` / power
  loss). This ADR only adds a _verification_ step on the e2e side: a _clean_ exit must not leak,
  and the harness now proves that. The "skip harness-owned `markflow-e2e-*`" guidance in ADR-0017
  still applies to any _future standalone sweeper_; the residue gate is a verifier, **not** a
  sweeper — it reads only this run's own registry, never the whole `%TEMP%`.
- The contract guards (`e2e/guards/project-ownership.test.ts`, `e2e/guards/e2e-parallelism.test.ts`,
  `e2e/guards/residue-registry.test.ts`, `e2e/guards/serial-reset.test.ts`) were updated:
  `residue-gate` is a known project name, it is a serial project, its `retries: 0` is permitted
  alongside `e2e-perf-diag`, and **every temp-allocating project's `teardown:` link is pinned**.
  The pinned set is **derived** twice over: the guard scans `e2e/helpers/*.ts` for modules that
  actually call an allocating API, then scans each project's specs (via the shared `scan-specs.ts`
  walk) for imports of those modules. Wrapper helpers (`fixtures.ts`, `perf-fixture.ts`) therefore
  count, and a future temp-allocating project that forgets its `teardown:` link turns the guard red
  on its own. Playwright's own "teardown project must not have dependencies" rule is NOT restated
  here (`testing.md`, "Assert the logic you wrote").
- `package.json`'s `e2e:app` was extended to `--project=residue-gate` so the guard's project-name
  set stays in sync with `playwright.config.ts`.
- `e2e/.residue-registry/` is git-ignored (harness bookkeeping, never source).
- Verification requires three pieces of evidence: a full `npm run e2e:app` passes; deliberately
  leaking a directory makes the gate produce `1 failed` (a genuine JUnit test failure, not a
  run-level error); and a before/after count of `%TEMP%` `markflow-*` directories shows zero net
  growth across a run. **Recorded reasons for the non-executable parts** (`testing.md`, "A guard is
  finished when"): the red path is permanently reproducible at the unit layer in
  `e2e/helpers/temp.test.ts`; an end-to-end red was produced once with a throwaway injected-leak
  spec, which is deliberately NOT committed (a permanently failing spec would break every run);
  zero net growth and the `--project` / `--shard` scheduling were observed with real runs and
  `playwright test --list` (framework behaviour, not logic we wrote). Every assertion that CAN be
  executable is: registry bookkeeping, helper derivation, serial resets, and the `2×2×2` close
  matrix are all pinned in the unit suite. The observed test counts are **snapshots**, not pinned
  numbers: the executable contract lives in `e2e/guards/`, and `testing.md` ("Contract guards")
  requires a relation or a floor over an exact count that only ever grows.
- Mutation evidence (`testing.md`, "A mutation turns it red and restoring turns green"): removing
  any one project's `teardown:` link turns `e2e-parallelism.test.ts` red; making `cleanupTempDirs`
  a no-op turns the ownership UT red; dropping a serial `beforeEach`'s `resetAppState` turns
  `serial-reset.test.ts` red; removing the `resetResidueRegistry()` call, adding a deletion API to
  the gate spec, or renaming the `.gitignore` rule each turn `residue-registry.test.ts` red; and
  dropping CRLF handling in that guard's ignore-rule helper turns its LF/CRLF UT red. Restoring
  each turns it green again. That guard parses `.gitignore` line-wise rather than with a
  `$`-anchored regex, so it stays deterministic on both LF and CRLF checkouts — pinned by a UT.
- The 5s poll in `temp-cleanup.e2e.spec.ts` that ADR-0035 recorded as flaky was shorter than the
  deleter's worst case (`DEFER_DELAY_MS + RETRY_GRACE_MS = 8s`). It now uses `RESIDUE_GRACE_MS`,
  the same derived deadline the gate waits on; ADR-0035 is append-only and stays as written.
- Adding a fifth Playwright project invalidated a previously recorded "exactly four projects"
  invariant. The re-judgement belongs here rather than in a separate decision record, because it is
  the same decision viewed from a later state: `residue-gate` is a teardown-only project, so the
  invariant was never "four projects" but "one spec file, one project" (ADR-0034) plus "every
  temp-allocating project reaches exactly one residue gate". Both are pinned by guards, which now
  derive the project set instead of hard-coding its size. No `ci.yml`, `package.json` (other than
  `e2e:app`), or project-name change was needed for the gate itself: a teardown project is pulled
  in by the `teardown:` link even under `--project` filtering and `--shard` (verified for all four
  shards).
- Known flake, deliberately **not** suppressed: under full parallel load one
  `menu-i18n-lifecycle` case can hit the 15s graceful-close timeout, which the strict
  timeout-is-a-failure policy now surfaces as a real failure. Running that spec alone passes
  (7 tests), and a second full run passed the whole suite. The timeout is NOT relaxed and the case is NOT
  skipped — widening either would restore the silent-green failure mode this decision removes.
  Per `testing.md` ("a flaky e2e is evidence"), the reproduction rate is raised before any
  downgrade; a separate diagnosis is left open rather than folded into this ADR.
