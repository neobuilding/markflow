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
// runs cleanupTempDirs() in a `finally` block, so a failed close, force-kill or an
// already-exited app still reclaims that worker's allocations. Specs close their app
// from whichever hook fits (afterEach, afterAll for serial reuse, or the test body),
// but a CRASHED worker never reaches any hook at all — that is exactly why every
// allocation is also written to the on-disk registry below for the residue gate.
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DELETER_MAX_LIFETIME_MS } from '../../electron/main/lib/temp-cleanup'

/** Directories this harness has allocated and therefore must clean up itself. */
const tracked = new Set<string>()

/**
 * Run-scoped, on-disk record of every temp directory this harness allocates.
 *
 * `tracked` above is in-memory and a worker crash (the exact path that leaks a
 * directory) loses it. So every allocation is ALSO appended to disk by the
 * allocating worker. The residue gate (e2e/residue-gate) scans these files
 * after all specs finish and asserts none of the recorded paths still exist —
 * catching leaks a crashed worker could never report itself.
 *
 * Each worker writes its OWN file (named by PID), so concurrent `appendFileSync`
 * calls never touch the same file and no inter-worker locking is needed. The
 * gate only reads; it never races a writer.
 */
export const RESIDUE_REGISTRY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.residue-registry',
)

/**
 * Scheduling headroom on top of the deleter's worst case: the gate starts only after the
 * last worker exits, and it polls in 250ms steps, so the deleter gets extra slack before
 * the gate declares a leak. The total is derived — never hardcoded independently, or a
 * gate that gives up early turns a SLOW but successful delete into a false red.
 * temp.test.ts pins the relation.
 */
const SCHEDULING_MARGIN_MS = 2_000

export const RESIDUE_GRACE_MS = DELETER_MAX_LIFETIME_MS + SCHEDULING_MARGIN_MS

function ensureRegistryFile(registryDir: string): string {
  // Recreate the directory on EVERY write, not just the first one in this process.
  // A cached "already created" flag makes later appendFileSync calls fail with
  // ENOENT whenever anything removes the directory mid-run, which would leave
  // allocations unrecorded and let the gate pass vacuously. mkdirSync is idempotent.
  mkdirSync(registryDir, { recursive: true })
  return join(registryDir, `${process.pid}.jsonl`)
}

/**
 * Append one allocation to this run's registry. The registry is the ONLY input to
 * the residue gate: an unrecorded allocation makes a leak invisible, so a failed
 * write must be LOUD rather than swallowed as "best-effort diagnostics". Callers
 * are test setup, never production exit paths, so failing fast is safe.
 *
 * `registryDir` is injectable so unit tests can exercise the whole chain in an
 * isolated directory; production callers use RESIDUE_REGISTRY_DIR.
 */
export function recordAllocation(dir: string, registryDir: string = RESIDUE_REGISTRY_DIR): void {
  appendFileSync(ensureRegistryFile(registryDir), dir + '\n')
}

/** Injectable fs surface so the residue audit logic can be unit-tested without a real disk. */
export interface ResidueDeps {
  existsSync: (path: string) => boolean
  readdirSync: (path: string) => string[]
  readFileSync: (path: string, encoding: 'utf-8') => string
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void
}

const nodeResidueDeps: ResidueDeps = { existsSync, readdirSync, readFileSync, rmSync }

/**
 * Every path registered by this run, deduplicated. Only `*.jsonl` files are read,
 * so a stray file in the registry directory can never be mistaken for a path.
 */
export function readResidueRegistry(
  registryDir: string = RESIDUE_REGISTRY_DIR,
  deps: ResidueDeps = nodeResidueDeps,
): string[] {
  if (!deps.existsSync(registryDir)) return []
  const allocated = new Set<string>()
  for (const file of deps.readdirSync(registryDir)) {
    if (!file.endsWith('.jsonl')) continue
    for (const line of deps.readFileSync(join(registryDir, file), 'utf-8').split('\n')) {
      const p = line.trim()
      if (p) allocated.add(p)
    }
  }
  return [...allocated]
}

export interface FindResidueOptions {
  /** How long to wait for the app's detached deleter before declaring a leak. */
  graceMs: number
  pollMs?: number
  existsSync?: (path: string) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Capture the EVIDENCE: which registered paths are still present after giving
 * the app's deferred deleter `graceMs` to finish. A single deadline is shared by
 * all paths (not one grace window per path), so N leftovers cannot stall the run
 * for N × graceMs. Callers MUST clean up the result and only THEN assert.
 */
export async function findResidue(
  allocated: readonly string[],
  options: FindResidueOptions,
): Promise<string[]> {
  const exists = options.existsSync ?? existsSync
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = options.pollMs ?? 250

  const pending = new Set(allocated.filter((p) => exists(p)))
  if (pending.size === 0) return []

  let current = now()
  const deadline = current + options.graceMs
  while (pending.size > 0 && current < deadline) {
    await sleep(pollMs)
    current = now()
    for (const p of [...pending]) {
      if (!exists(p)) pending.delete(p)
    }
  }
  return [...pending]
}

/**
 * rmSync that never throws: one locked path must not fail the caller's loop over the
 * others, and teardown-time cleanup must not turn evidence-gathering into a crash.
 */
function rmBestEffort(path: string, rm: ResidueDeps['rmSync']): void {
  try {
    rm(path, { recursive: true, force: true })
  } catch {
    // Locked by a lingering process: leave it rather than failing the teardown.
  }
}

/** Best-effort removal of leaked directories; one locked path must not hide the others. */
export function cleanupResidue(
  paths: readonly string[],
  deps: ResidueDeps = nodeResidueDeps,
): void {
  for (const p of paths) {
    rmBestEffort(p, deps.rmSync)
  }
}

/**
 * Create an isolated temp directory owned by the test harness.
 *
 * @param prefix       Directory-name prefix; must start with `markflow-` so the name
 *                     space stays recognisable and separated from the app's own dir.
 * @param registryDir  Injectable registry for unit tests, so ownership bookkeeping
 *                     can be asserted without writing to the real run's registry.
 */
export function mkTempDir(
  prefix = 'markflow-e2e-',
  registryDir: string = RESIDUE_REGISTRY_DIR,
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tracked.add(dir)
  recordAllocation(dir, registryDir)
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

/**
 * Wipe the previous run's registry ONCE, at the start of a run. Best-effort: the
 * directory may not exist yet. Kept here (not in global-setup) so the wipe is a
 * pure, unit-testable piece of the same ownership logic that writes the registry.
 */
export function resetResidueRegistry(registryDir: string = RESIDUE_REGISTRY_DIR): void {
  rmBestEffort(registryDir, rmSync)
}

/**
 * Remove every directory this harness allocated. Best-effort per entry; `deps` is
 * injectable so a unit test can prove that one locked path cannot hide the others.
 */
export function cleanupTempDirs(deps: Pick<ResidueDeps, 'rmSync'> = nodeResidueDeps): void {
  for (const dir of tracked) {
    rmBestEffort(dir, deps.rmSync)
  }
  tracked.clear()
}
