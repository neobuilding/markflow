# No test-only environment switches in production code

The main process used to read `MARKFLOW_E2E=1` (skip the userData redirect into `%TEMP%`, and later also skip the single-instance lock and a startup sweep) and `MARKFLOW_CLEANUP_DEBUG=1` (append diagnostics to `%TEMP%\mf-cleanup-debug.log`). Both are gone: production code contains no variable whose only purpose is telling the app "you are being tested". Test isolation is achieved with `--user-data-dir`, a real Chromium switch, and every running instance owns a private profile directory named `%TEMP%/markflow-<pid>`.

## Considered Options

- **Keep the environment switches.** Rejected: every switch is a second product. Tests then verify a variant nobody ships, and the divergence is invisible in review — `MARKFLOW_E2E` ended up guarding three unrelated behaviors, one of which was a real bug.
- **Honor `--user-data-dir` instead.** Chosen. Recognizing a caller-supplied profile directory is normal Chromium behavior and needs no special mode.
- **Use the single-instance lock to prove ownership of the shared profile.** Tried and rejected: it made the app single-instance (a dev could no longer open a second `npm run dev`), which is a functional regression. The lock went back to doing only its original UX job (hand argv to the running instance, packaged builds only).
- **Give every instance a private directory.** Chosen, because sharing is unsafe, not merely untidy. Measured contents of one instance's profile: ~1.8 MB / 35 files, all Chromium runtime data (Code Cache, GPUCache, Dawn*Cache, Shared Dictionary, Local Storage/leveldb, Network/Trust Tokens, DIPS) and no business data. `Local Storage/leveldb` carries its own single-writer `LOCK`, and the cache index files differ between instances, so two processes sharing a profile would corrupt each other. Ownership becomes structural: an instance can only ever clean up a directory that is its own, whether another instance is running or not. This costs nothing in persistence, because the app already removes its profile when it quits.
- **Run the e2e suite against the packaged build.** Not adopted: closest to reality, but it adds a build to every run and rewrites the renderer's load path. The remaining deviations are inputs a real caller could legitimately use (`VITE_DEV_SERVER_URL`, `--no-sandbox`) or things Playwright physically cannot click (native OS dialogs).

## Consequences

- No startup sweep: nothing is deleted on launch whose owner cannot be proven dead. If an instance is force-killed, its directory survives — accepted deliberately, see ADR 0017. (Windows does not reclaim `%TEMP%` on its own, so that residue stays until someone removes it.)
- Because the app cannot detect "test mode", whatever the suite needs must be expressed as real input, keeping the tested surface identical to the shipped surface.
- Diagnostics died with their switch; the cleanup path is pinned by unit tests plus `temp-cleanup.e2e.spec.ts`.
- A guard test (`electron/main/test-support/no-test-env-switches.test.ts`) fails the suite if either variable reappears in `electron/`, `src/` or `e2e/`.
