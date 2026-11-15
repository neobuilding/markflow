// Unit tests for the residue registry and the gate's audit logic.
//
// Test pyramid: these functions are PURE (fs and clock are injected), so they belong
// at the unit layer. The e2e residue-gate spec only orchestrates them; it should not
// be the only place that can prove "a leaked directory is reported".
import { describe, it, expect } from 'vitest'
import { rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTestDir } from '../../electron/main/test-support/tmp'
import {
  RESIDUE_GRACE_MS,
  recordAllocation,
  readResidueRegistry,
  findResidue,
  cleanupResidue,
  cleanupTempDirs,
  mkTempDir,
  resetResidueRegistry,
  untrackTempDir,
  type ResidueDeps,
} from './temp'
import {
  DEFER_DELAY_MS,
  RETRY_GRACE_MS,
  DELETER_MAX_LIFETIME_MS,
} from '../../electron/main/lib/temp-cleanup'

/** A fake clock whose `sleep` advances the time `findResidue` observes. */
function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
  }
}

describe('residue grace window', () => {
  it('outlives the app deleter worst case (defer + full retry budget)', () => {
    // The gate must not declare a leak while the app's detached deleter may still
    // legitimately be retrying. A hardcoded 5s grace used to be shorter than the
    // deleter's 2s + 6s, which would turn a SLOW success into a false red. Strictly
    // GREATER: a zero scheduling margin would put the gate back on the boundary.
    expect(DELETER_MAX_LIFETIME_MS).toBe(DEFER_DELAY_MS + RETRY_GRACE_MS)
    expect(RESIDUE_GRACE_MS).toBeGreaterThan(DELETER_MAX_LIFETIME_MS)
  })
})

describe('readResidueRegistry', () => {
  const deps = (over: Partial<ResidueDeps> = {}): ResidueDeps => ({
    existsSync: () => true,
    readdirSync: () => [],
    readFileSync: () => '',
    rmSync: () => {},
    ...over,
  })

  it('returns an empty list when no registry exists (nothing was allocated)', () => {
    expect(readResidueRegistry('/missing', deps({ existsSync: () => false }))).toEqual([])
  })

  it('reads only *.jsonl files, trims blank lines and deduplicates across workers', () => {
    const registry = deps({
      readdirSync: () => ['111.jsonl', '222.jsonl', 'notes.txt'],
      readFileSync: (file) =>
        file.endsWith('111.jsonl')
          ? '/tmp/a\n/tmp/b\n\n'
          : file.endsWith('222.jsonl')
            ? '/tmp/b\n  /tmp/c  \n'
            : '/tmp/never-read',
    })
    expect(readResidueRegistry('/registry', registry)).toEqual(['/tmp/a', '/tmp/b', '/tmp/c'])
    expect(registry.rmSync).toBeDefined()
  })

  it('round-trips a real recorded allocation end to end', () => {
    const dir = mkTestDir('markflow-registry-test-')
    const allocated = join(dir, 'user-data')
    recordAllocation(allocated, dir)
    recordAllocation(allocated, dir) // duplicate reads must not double-report
    expect(readResidueRegistry(dir)).toEqual([allocated])
  })

  it('recreates the registry directory if it was removed mid-run', () => {
    // Regression: a cached "already created" flag made every later append fail with
    // ENOENT, so allocations after the deletion went unrecorded and the gate passed
    // green on a dirty machine.
    const dir = mkTestDir('markflow-registry-recreate-')
    const registry = join(dir, 'registry')
    recordAllocation('/tmp/first', registry)
    rmSync(registry, { recursive: true, force: true })
    recordAllocation('/tmp/second', registry)
    expect(existsSync(registry)).toBe(true)
    expect(readResidueRegistry(registry)).toContain('/tmp/second')
  })
})

describe('findResidue', () => {
  it('reports a deliberately leaked directory — the gate CAN go red', async () => {
    // Positive assertion: a path that survives the whole grace window MUST be
    // returned. If this ever returns [], the residue gate can never fail.
    const clock = fakeClock()
    const result = await findResidue(['/tmp/leaked'], {
      graceMs: RESIDUE_GRACE_MS,
      pollMs: 100,
      existsSync: () => true,
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(result).toEqual(['/tmp/leaked'])
    expect(clock.sleeps.length).toBeGreaterThan(0)
  })

  it('returns nothing for a path that was already reclaimed', async () => {
    const clock = fakeClock()
    const result = await findResidue(['/tmp/gone'], {
      graceMs: RESIDUE_GRACE_MS,
      existsSync: () => false,
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(result).toEqual([])
    expect(clock.sleeps).toEqual([]) // no pointless polling
  })

  it('waits for the app deleter and clears a path removed inside the grace window', async () => {
    const clock = fakeClock()
    let present = true
    const result = await findResidue(['/tmp/slow-delete'], {
      graceMs: RESIDUE_GRACE_MS,
      pollMs: 100,
      existsSync: () => present,
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms)
        if (clock.now() >= 300) present = false
      },
    })
    expect(result).toEqual([])
    expect(clock.sleeps.length).toBeGreaterThan(0)
  })

  it('uses ONE shared deadline, not one grace window per path', async () => {
    const clock = fakeClock()
    const paths = Array.from({ length: 10 }, (_, i) => `/tmp/leak-${i}`)
    const result = await findResidue(paths, {
      graceMs: 1_000,
      pollMs: 100,
      existsSync: () => true,
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(result).toEqual(paths)
    expect(clock.now()).toBeLessThanOrEqual(1_100) // not 10 × graceMs
  })
})

describe('cleanupResidue', () => {
  it('removes every leaked path even when one rm throws', () => {
    const removed: string[] = []
    cleanupResidue(['/tmp/a', '/tmp/locked', '/tmp/c'], {
      existsSync: () => true,
      readdirSync: () => [],
      readFileSync: () => '',
      rmSync: (p) => {
        if (p === '/tmp/locked') throw new Error('EPERM')
        removed.push(p)
      },
    })
    expect(removed).toEqual(['/tmp/a', '/tmp/c'])
  })

  it('removes a real leaked directory with the default fs deps', () => {
    const leaked = mkTestDir('markflow-cleanup-residue-')
    cleanupResidue([leaked])
    expect(existsSync(leaked)).toBe(false)
  })
})

describe('recordAllocation', () => {
  it('fails LOUDLY when the registry cannot be written', () => {
    // ADR-0036 §2: an unrecorded allocation is invisible residue, so a failed
    // write must never be swallowed as best-effort diagnostics. mkdirSync on an
    // existing FILE throws, which is a deterministic way to reach that path.
    const dir = mkTestDir('markflow-registry-loud-')
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    expect(() => recordAllocation('/tmp/invisible', blocker)).toThrow()
  })
})

describe('resetResidueRegistry', () => {
  it("wipes the previous run's registry and tolerates a missing one", () => {
    const dir = mkTestDir('markflow-registry-reset-')
    const registry = join(dir, 'registry')
    recordAllocation('/tmp/stale', registry)
    expect(existsSync(registry)).toBe(true)
    resetResidueRegistry(registry)
    expect(existsSync(registry)).toBe(false)
    expect(() => resetResidueRegistry(registry)).not.toThrow()
  })
})

describe('temp directory ownership', () => {
  it('mkTempDir registers the allocation and cleanupTempDirs reclaims it', () => {
    // Pyramid: this is pure fs logic. It used to live ONLY in an e2e spec whose own
    // comment said "No Electron launch needed"; proving it here is faster and gives
    // a mutation target (make cleanupTempDirs a no-op and this goes red).
    const registry = mkTestDir('markflow-ownership-registry-')
    const dir = mkTempDir('markflow-ownership-ut-', registry)
    expect(existsSync(dir)).toBe(true)
    expect(readResidueRegistry(registry)).toContain(dir)
    cleanupTempDirs()
    expect(existsSync(dir)).toBe(false)
  })

  it('untrackTempDir leaves both the directory AND its registry entry intact', () => {
    // ADR-0036 §2: untracking removes the harness from the picture so the gate can
    // prove the APP deleted its own dir, but the allocation stays registered.
    const registry = mkTestDir('markflow-untrack-registry-')
    const dir = mkTempDir('markflow-untracked-ut-', registry)
    untrackTempDir(dir)
    cleanupTempDirs()
    expect(existsSync(dir)).toBe(true)
    expect(readResidueRegistry(registry)).toContain(dir)
    rmSync(dir, { recursive: true, force: true })
  })

  it('cleanupTempDirs keeps going when one removal throws', () => {
    const registry = mkTestDir('markflow-locked-registry-')
    const locked = mkTempDir('markflow-locked-ut-', registry)
    const free = mkTempDir('markflow-free-ut-', registry)
    const removed: string[] = []
    cleanupTempDirs({
      rmSync: (p) => {
        if (p === locked) throw new Error('EPERM')
        removed.push(p)
      },
    })
    expect(removed).toEqual([free])
    rmSync(locked, { recursive: true, force: true })
    rmSync(free, { recursive: true, force: true })
  })
})

describe('findResidue default dependencies', () => {
  it('uses the real fs and clock when nothing is injected', async () => {
    const present = mkTestDir('markflow-find-residue-')
    const result = await findResidue([present], { graceMs: 20, pollMs: 5 })
    expect(result).toEqual([present])
    expect(await findResidue([join(present, 'gone')], { graceMs: 20 })).toEqual([])
  })
})
