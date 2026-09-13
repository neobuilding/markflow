# ADR-0014: Extract the filesystem case-sensitivity rule into an injectable seam + de-duplicate across main and renderer

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** markflow maintainers

## Context

Two pieces of code expressed VS Code's filesystem case-sensitivity rule — "only Linux treats
`Note.md` and `note.md` as two different files; Windows/macOS treat them as the same" — in two
different places:

- `electron/main/ipc/documents.ts` inlined it inside `isSamePath`:
  `process.platform !== 'linux' && a.toLowerCase() === b.toLowerCase()`.
- `src/renderer/src/lib/utils.ts` expressed the same rule in `foldName` /
  `pathCaseSensitive` (`!isMac() && !isWindows() ? name : name.toLowerCase()`).

This caused two problems:

1. **Duplication.** The same domain rule lived in two processes, each reading a different
   environment source (`process.platform` vs `navigator.userAgent`). A future change to the rule
   would have to be made in two places.
2. **Environment-coupled coverage, and a CI/local mismatch.** `documents.ts` read `process.platform`
   directly inside domain logic. Its branch was only exercisable on the runner's _real_ OS:
   local Windows covered the non-Linux side, CI Linux covered the Linux side — so CI failed the
   global 100% branch gate (`documents.ts` 99.49%) while local passed. Coverage conclusions were
   held hostage by the runner's operating system.

The fix had to make the rule (a) defined in exactly one place, and (b) testable deterministically
on any runner without depending on the OS.

## Decision

1. **Pure rule in `shared/fileUtils.ts`** (environment-agnostic, no `process` / no `navigator`):
   - `arePathsSame(a, b, caseSensitive)` — `a === b || (!caseSensitive && a.toLowerCase() === b.toLowerCase())`.
   - `foldName(name, caseSensitive)` — `caseSensitive ? name : name.toLowerCase()`.
     These are trivially, deterministically unit-testable with explicit arguments; no OS faking.

2. **Edge detection stays at the boundary of each process**, because the source differs:
   - `electron/main/lib/disk-io.ts#isFileSystemCaseSensitive()` reads `process.platform`
     (Node context).
   - the renderer keeps `pathCaseSensitive()` reading `navigator.userAgent` (browser context).
     Both pass their boolean into the shared pure helper. Neither bakes the platform check into the
     rule.

3. **The seam is injected, not read in place.** `documents.ts` keeps a module-local
   `activeIsFileSystemCaseSensitive` that `isSamePath` consults (`arePathsSame(a, b, activeIsFileSystemCaseSensitive())`).
   `registerDocumentHandlers(..., io, isFileSystemCaseSensitiveSeam?)` captures the caller's seam at
   registration time (default = the real `isFileSystemCaseSensitive()` detector). So the domain rule
   is fully environment-free, and the OS-ness is supplied by whoever wires the handlers — the app in
   production, the test in a unit. The renderer's `foldName(name)` likewise delegates to the shared
   `foldName(name, pathCaseSensitive())`.

4. **Testing strategy (call the seam directly — no module mock, no global mutation):**
   - `shared/fileUtils.test.ts` exercises the pure rule directly — 4 cases for `arePathsSame` + 2 for
     `foldName` cover every branch on any runner.
   - `electron/main/lib/disk-io.test.ts` exercises the edge detector by pinning `process.platform`
     (the one legitimate place to fake the OS: we are testing the detector itself).
   - `documents.test.ts` injects the seam into the two rename case tests via
     `registerDocumentHandlers(fakeIpcMain, fakeApp, getWin, io, () => false)` / `() => true`, then
     re-registers with defaults in `finally` so later tests are never left with a swapped `io`/seam.
     This covers both branches deterministically on any runner without mocking a module or mutating
     `process.platform` inside the consumer.

### Trade-off: dependency injection over module mocking

We first tried mocking the platform module (`vi.mock('../lib/disk-io', …)` / `vi.spyOn`) to drive the
seam, but the cleaner and more robust choice is **dependency injection**: the seam is a parameter of
`registerDocumentHandlers`, so the test supplies a known boolean and the consumer "calls the seam
directly". This avoids every downside of module mocking:

- No `vi.mock` of the platform module, so there is nothing that can interfere with the pre-existing
  `vi.mock('node:fs', …)` that routes `nodeDiskIO` to an in-memory filesystem (`__memFs`).
- No mutation of `process.platform` in the consumer test (only `disk-io.test.ts`, which tests the
  detector, legitimately pins it).

One sharp edge we hit and fixed: `registerDocumentHandlers` re-installs **all** document handlers, so a
case test that re-registers with a custom `io`/seam leaves that state behind for the next test unless it
is restored. The case tests therefore re-register with defaults in `finally`. (An earlier attempt that
omitted this reset surfaced as `ENOENT`/empty results in the unrelated rename/undo/list tests — not a
`node:fs` mock breakage, but stale handler state left by the test itself.)

## Consequences

- **Single source of truth** for the case-sensitivity rule; the renderer duplicate is gone.
- **Deterministic coverage**: `documents.ts` reaches 100% branch on CI Linux _and_ local Windows,
  closing the original gate failure.
- **Domain logic is environment-free**: only `electron/main/lib/disk-io.ts` (and the renderer's
  `pathCaseSensitive`) touch an environment source; everything else is pure and injectable.
- **Testable by injection, not by mock**: the platform seam is supplied at handler-registration time,
  so unit tests drive both branches with zero module mocking and zero global mutation.
