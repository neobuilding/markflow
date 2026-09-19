// electron/main/test-support/tmp.ts
//
// The unit-test suite allocates real temp directories under %TEMP% (fixtures for the
// folder watcher, open-folder set, document store, export pipeline, ...). Vitest does not
// clean %TEMP% itself, so every directory created here is tracked and removed when the test
// worker exits — that is the test suite cleaning up its OWN garbage, nobody else's.
//
// This mirrors the e2e harness's e2e/helpers/temp.ts by design: allocate through one helper
// that records the path, and reclaim only those recorded paths (no %TEMP% scan, so it can
// never touch a directory some other process owns).
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Temp dirs this test process has allocated and therefore must clean up itself. */
const tracked = new Set<string>()

/**
 * Create an isolated temp directory that the test suite owns. Prefer this over a bare
 * `mkdtempSync(join(tmpdir(), prefix))` so the path is reclaimed automatically.
 */
export function mkTestDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tracked.add(dir)
  return dir
}

/** Remove every directory this process allocated. Best-effort per entry. */
export function cleanupTestDirs(): void {
  for (const dir of tracked) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Locked by a lingering child (e.g. a spawned renderer) — leave it rather than failing.
    }
  }
  tracked.clear()
}
