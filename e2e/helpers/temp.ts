// e2e/helpers/temp.ts
//
// Ownership note: every temp directory the e2e harness allocates with mkdtempSync
// is e2e-owned garbage. The MarkFlow app cleans up only its OWN user-data-dir; it
// neither scans nor touches anything else in %TEMP%. So the harness reclaims its
// own allocations here — that is its job, nobody else's.
//
// Instead of ~35 scattered `rmSync` calls that are easy to forget (and silently
// skipped when a test fails mid-way), every temp dir is allocated through
// mkTempDir(), which records it; cleanupTempDirs() removes them all. closeApp()
// runs cleanupTempDirs() in a `finally` block, and since every spec closes its app
// from afterEach, no allocation can leak — even when a close fails, force-kills,
// or the app has already exited.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Directories this harness has allocated and therefore must clean up itself. */
const tracked = new Set<string>()

/**
 * Create an isolated temp directory owned by the test harness.
 *
 * @param prefix Directory-name prefix; must start with `markflow-` so the name
 *               space stays recognisable and separated from the app's own dir.
 */
export function mkTempDir(prefix = 'markflow-e2e-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tracked.add(dir)
  return dir
}

/** Bring an externally-created directory (e.g. a user-data-dir) under tracking. */
export function trackTempDir(dir: string): string {
  tracked.add(dir)
  return dir
}

/**
 * Stop tracking a directory so cleanupTempDirs() will NOT remove it. Used by the
 * cleanup regression spec to keep the harness out of the picture, so the test can
 * prove the APPLICATION deleted its own user-data-dir rather than the test doing
 * it and hiding a regression.
 */
export function untrackTempDir(dir: string): void {
  tracked.delete(dir)
}

/** Remove every directory this harness allocated. Best-effort per entry. */
export function cleanupTempDirs(): void {
  for (const dir of tracked) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Locked by a lingering process: leave it rather than failing the teardown.
    }
  }
  tracked.clear()
}
