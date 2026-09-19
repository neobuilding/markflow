// electron/main/lib/temp-cleanup.test.ts
//
// These tests never touch a real instance's profile: every case allocates its own directory
// through mkTestDir() (reclaimed when the suite finishes), so a MarkFlow running elsewhere on
// this machine is never affected.
import { describe, it, expect } from 'vitest'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTestDir } from '../test-support/tmp'
import {
  OWN_TEMP_DIR_NAME,
  removeOwnTempDir,
  scheduleRemoveAfterExit,
  type TempCleanupDeps,
} from './temp-cleanup'

/** A fake spawn that records its invocation and returns an object with `unref`. */
function recordingSpawn() {
  const calls: unknown[][] = []
  const fn = (...args: unknown[]) => {
    calls.push(args)
    return { unref: () => {} }
  }
  return { fn, calls }
}

describe('temp-cleanup', () => {
  it('removeOwnTempDir deletes the app’s own temp dir (production name)', () => {
    // Same NAME as production (whose dirs are markflow-<pid>), but rooted in an isolated
    // directory: this must never touch a running instance's profile.
    const prodDir = join(mkTestDir('mf-tc-root-'), OWN_TEMP_DIR_NAME)
    mkdirSync(prodDir, { recursive: true })

    expect(removeOwnTempDir(prodDir)).toBe(true)
    expect(existsSync(prodDir)).toBe(false)
  })

  it('removeOwnTempDir deletes the runtime data the app wrote inside an e2e dir', () => {
    const e2eDir = mkTestDir('markflow-e2e-')
    mkdirSync(join(e2eDir, 'Local Storage'), { recursive: true })
    writeFileSync(join(e2eDir, 'Local State'), '{}')

    expect(removeOwnTempDir(e2eDir)).toBe(true)
    expect(existsSync(e2eDir)).toBe(false)
  })

  it('removeOwnTempDir refuses a directory that is not ours', () => {
    const foreign = mkTestDir('someone-elses-dir')

    expect(removeOwnTempDir(foreign)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
  })

  it('removeOwnTempDir reports true for an already-absent dir', () => {
    const absent = join(mkTestDir('mf-tc-root-'), `${OWN_TEMP_DIR_NAME}-absent-xyz`)
    expect(existsSync(absent)).toBe(false)

    expect(removeOwnTempDir(absent)).toBe(true)
  })

  // Regression guard: the whole exit-time cleanup silently did nothing twice because the
  // deferred deleter never ran. This pins "the deleter really deletes", not just
  // "a process was spawned". It intentionally out-lives its own test process.
  it(
    'scheduleRemoveAfterExit actually removes the directory shortly afterwards',
    { timeout: 20_000 },
    async () => {
      const victim = mkTestDir(`${OWN_TEMP_DIR_NAME}-defer-`)
      mkdirSync(join(victim, 'Local Storage'), { recursive: true })
      writeFileSync(join(victim, 'Local State'), '{}')

      scheduleRemoveAfterExit(victim)

      // Poll rather than sleep a fixed duration: the deleter sleeps ~2s before acting.
      for (let i = 0; i < 40; i++) {
        if (!existsSync(victim)) break
        await new Promise((r) => setTimeout(r, 250))
      }
      expect(existsSync(victim)).toBe(false)
    },
  )

  // --- Error-swallowing / guard branches (the 100% coverage floor) ---

  it('isOwnTempDir returns false when basename throws (guards an unknown path)', () => {
    const badBasename = (() => {
      throw new Error('bad path')
    }) as unknown as TempCleanupDeps['basename']

    expect(
      removeOwnTempDir(join(mkTestDir('mf-tc-root-'), 'anything'), { basename: badBasename }),
    ).toBe(false)
  })

  it('removeOwnTempDir swallows an rm error and reports not gone', () => {
    const dir = mkTestDir(`${OWN_TEMP_DIR_NAME}-rmfail-`)

    const throwingRmSync = (() => {
      throw new Error('EPERM')
    }) as unknown as TempCleanupDeps['rmSync']

    expect(removeOwnTempDir(dir, { rmSync: throwingRmSync })).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  it('scheduleRemoveAfterExit does nothing for a non-own path', () => {
    const spawn = recordingSpawn()
    scheduleRemoveAfterExit(mkTestDir('foreign-dir'), { spawn: spawn.fn as never })

    expect(spawn.calls).toHaveLength(0)
  })

  it('scheduleRemoveAfterExit swallows a spawn error', () => {
    const victim = mkTestDir(`${OWN_TEMP_DIR_NAME}-spawnfail-`)
    const throwingSpawn = (() => {
      throw new Error('ENOENT')
    }) as unknown as TempCleanupDeps['spawn']

    expect(() => scheduleRemoveAfterExit(victim, { spawn: throwingSpawn })).not.toThrow()
  })
})
