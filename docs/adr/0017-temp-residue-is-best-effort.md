# Temp residue is best-effort; the platform is the floor

The app removes its own user-data-dir when it quits — synchronously at `will-quit` and again from a detached helper after the process has exited — and does **not** sweep for leftovers at startup. An instance that is force-killed or loses power leaves its `%TEMP%/markflow-<pid>` directory behind, and that is accepted rather than chased.

## Why "guarantee cleanup" is not an option

A `SIGKILL` / `taskkill /F` / power loss means no code of ours runs at all, so no cleanup strategy can be complete by definition. Mature software therefore optimises for a different goal: make the leak window small, make residue harmless and identifiable, and let the platform reclaim the rest.

What that playbook looks like, and why only part of it applies here:

- **Delete immediately after use, not in a batch at exit.** Shrinks the window to milliseconds. Not available to us: the data is a Chromium profile tree that another process owns for the whole session.
- **POSIX: create → `unlink()` at once → keep using the fd.** The only truly crash-proof technique (the kernel frees the blocks when the fd is reaped, even on `SIGKILL`), and Windows' `FILE_FLAG_DELETE_ON_CLOSE` is its counterpart. Both work for **single files only** — not for a directory tree held by Chromium.
- **Make residue self-healing.** VS Code's IPC handle: try to serve → `EADDRINUSE` → try to connect → connection refused means it is stale → `unlinkSync` → retry (`src/vs/code/electron-main/main.ts:352-407`). It _probes_ instead of guessing. Not applicable here: a profile is not a resource a second instance may take over — two instances sharing one corrupts it, which is why each instance gets its own (ADR 0016).
- **Sweep by age, under your own prefix.** The accepted shape when sweeping really is warranted: VS Code's `codeCacheCleaner` deletes entries whose `mtime` is older than 7 days (Insiders) / 3 months (stable) — and notably it sweeps **inside `userDataPath` only, never `os.tmpdir()`**.
- **Let the platform be the floor.** Linux: `systemd-tmpfiles` cleans `/tmp` by age — a standard distro mechanism. macOS: periodic cleanup of stale `$TMPDIR` items. Windows: `%TEMP%` is **not** reclaimed by default, so this floor is weakest on the platform most of our users are on.

## Considered Options

- **Startup sweep of a fixed path.** Removed: it deleted a live instance's profile (BUG-1). A sweep must be able to prove a directory's owner is dead, and a fixed path proves nothing.
- **Single-instance lock as the ownership proof.** Reverted: it made the app single-instance, so a second `npm run dev` could no longer open — a functional regression. The lock is back to doing only its original UX job (packaged builds hand argv to the running instance).
- **Private directory per instance.** Adopted (ADR 0016): ownership becomes structural, so cleanup cannot reach another instance's data and multiple instances may run side by side.
- **Age-based sweep of our own `markflow-` prefix** — list `%TEMP%` entries named `markflow-*`, skip any whose embedded pid is still alive, delete the rest once `mtime` passes a threshold (VS Code's `codeCacheCleaner` is the reference shape). **Rejected, not planned.** For the record this is _not_ the dangerous "scan `%TEMP%` for stale-looking things" pattern the project already rejected: it only reads our own prefix and `mtime`, and `markflow-<pid>` even lets it prove the pid is dead first. It was declined anyway — the residue it would remove is bounded by the number of crashes, is identifiably named and removable by hand, and every extra bulk-delete path is another chance to delete something live (BUG-1 was exactly that). Revisit only with concrete evidence of accumulation.

## Consequences

- Residue appears only after an abnormal exit, is bounded by the number of crashes, and is individually identifiable by name.
- Nothing we delete at startup can belong to a running instance, which is the property that made the previous layout unsafe.
- No sweeper exists, so the app has exactly ONE deletion path: an owner removing its own directory when it quits. Should that ever change, any sweeper must only consider paths carrying our prefix, skip harness-owned `markflow-e2e-*` directories (the harness reclaims those itself) and be pinned by a unit test.
- In e2e the app's own `userData` directory IS a harness-allocated `markflow-e2e-*` container. The app still removes the runtime data it wrote inside that directory at quit (the owner-removes-its-own-dir path, not a sweeper) — the harness untracks the directory first (`temp-cleanup.e2e.spec.ts`) so there is no double-free. The "skip harness-owned" guidance above therefore applies only to a _future standalone sweeper_, never to this quit-time removal.
