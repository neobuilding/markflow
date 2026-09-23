// electron/main/lib/temp-cleanup.ts
//
// MarkFlow redirects its Electron userData into the system temp directory (see
// electron/main/index.ts). Windows never cleans %TEMP%, so the app must remove
// ITS OWN user-data-dir.
//
// Ownership boundary: this module handles ONLY the app's own temp path. It deliberately
// does NOT scan %TEMP% for other `markflow-*` entries — those were created by whoever
// owns them (e.g. the e2e harness allocates its own temp dirs and reclaims them itself).
//
// Why one synchronous attempt is not enough — all three points verified experimentally:
//   1. A synchronous rmSync at `will-quit` only PARTIALLY works: Chromium is still using
//      the profile, so some files refuse deletion and Node's recursive rm aborts the
//      whole tree.
//   2. Renaming the dir aside for isolation FAILS with EPERM for exactly the same reason,
//      so it cannot be used to "park" the leftover.
//   3. Chromium ALSO flushes state (Preferences / Local State) during teardown, i.e. AFTER
//      step 1 — which silently re-creates the directory we just deleted.
// So the only moment a removal is guaranteed to succeed is shortly AFTER this process and
// all its Chromium children have exited. A process cannot delete something after itself,
// so the job is handed to a short-lived detached helper below. If even that helper is killed
// (force-kill, power loss), the directory survives — see ADR 0017. We deliberately do NOT
// sweep for leftovers at startup: on this machine a sweep would have to guess which directories
// belong to a dead process, and guessing wrong means deleting a live instance's data.
//
// (This entire rat's nest is Windows-specific: POSIX unlink already removes open files from
// the namespace, so the synchronous attempt alone is enough there — but the same code path
// is used everywhere rather than maintaining a second, divergent implementation.)
//
// Testability: the native calls (fs / spawn) are bundled into an injectable `TempCleanupDeps`
// so unit tests can drop in fakes that throw, covering the error-swallowing branches without
// touching the real filesystem. Production callers never pass deps, so behavior is unchanged.
import { rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Name prefix marking a directory as MarkFlow's own runtime data, so cleanup can refuse
 * anything else. Each instance gets `markflow-<pid>` (see index.ts); e2e instances are
 * `markflow-e2e-<random>` and belong to the harness, which reclaims them itself.
 */
export const OWN_TEMP_DIR_NAME = 'markflow'

/** Wait long enough for this process (and its Chromium children) to fully exit. */
const DEFER_DELAY_MS = 2_000

/** Native surface this module touches, bundled for injection (see `docs/agents/testing.md`). */
export interface TempCleanupDeps {
  existsSync?: typeof existsSync
  rmSync?: typeof rmSync
  spawn?: typeof spawn
  basename?: typeof basename
  tmpdir?: typeof tmpdir
}

type ResolvedDeps = Required<TempCleanupDeps>

function resolveDeps(deps: TempCleanupDeps = {}): ResolvedDeps {
  return {
    existsSync: deps.existsSync ?? existsSync,
    rmSync: deps.rmSync ?? rmSync,
    spawn: deps.spawn ?? spawn,
    basename: deps.basename ?? basename,
    tmpdir: deps.tmpdir ?? tmpdir,
  }
}

function isOwnTempDir(path: string, basenameFn: typeof basename): boolean {
  // Guard: never wipe a real (non-temp) userData dir if the redirect is disabled.
  try {
    return basenameFn(path).startsWith(OWN_TEMP_DIR_NAME)
  } catch {
    return false
  }
}

/**
 * Best-effort synchronous removal, attempted at `will-quit`.
 * @returns true when nothing is left behind at that instant.
 */
export function removeOwnTempDir(path: string, deps: TempCleanupDeps = {}): boolean {
  const d = resolveDeps(deps)
  if (!isOwnTempDir(path, d.basename)) return false
  if (!d.existsSync(path)) return true
  try {
    d.rmSync(path, { recursive: true, force: true })
  } catch {
    // Still held by a tearing-down Chromium: the caller schedules the post-exit deleter.
  }
  return !d.existsSync(path)
}

/**
 * Schedule the removal to happen AFTER this process exits, when nothing holds the files
 * anymore. Always schedule this rather than only on failure: Chromium flushes Preferences
 * / Local State during teardown, i.e. it re-creates the directory after a successful
 * synchronous delete.
 *
 * The deleter runs with the runtime THIS APP already ships with (Electron's bundled Node,
 * via ELECTRON_RUN_AS_NODE) rather than shelling out. Two reasons, both learned the hard
 * way: an external shell is an extra dependency that may be unavailable or blocked, and
 * shell command construction is a quoting minefield — an earlier `cmd.exe` version broke on
 * paths containing spaces, which real user temp paths can have. Passing the work as a JS
 * string removes quoting from the picture entirely, and the same code path works on every
 * platform, so there is no per-OS branch to get wrong.
 *
 * Deliberately NOT relying on the OS: Windows has no "delete when closed" primitive short
 * of MOVEFILE_DELAY_UNTIL_REBOOT, which would defer the cleanup to the next boot.
 */
export function scheduleRemoveAfterExit(path: string, deps: TempCleanupDeps = {}): void {
  const d = resolveDeps(deps)
  if (!isOwnTempDir(path, d.basename)) return
  try {
    const script =
      `setTimeout(function () { try { require('node:fs').rmSync(${JSON.stringify(path)}, ` +
      `{ recursive: true, force: true }) } catch (e) {} }, ${DEFER_DELAY_MS})`
    const child = d.spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.unref()
  } catch {
    // Scheduling must never block exit; the next launch retries.
  }
}
