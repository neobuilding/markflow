// Contract tests for the registry the unit suite uses to reclaim its own temp directories.
//
// Nothing else in the repo would fail if this module silently stopped reclaiming anything:
// every suite would still pass and %TEMP% would simply start filling up again — which is
// exactly the failure these tests exist to catch. Keep them green.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkTestDir, cleanupTestDirs } from './tmp'

describe('test-support/tmp', () => {
  it('mkTestDir creates the directory it returns', () => {
    const dir = mkTestDir('mf-tmpmod-')

    expect(dir.startsWith(join(tmpdir(), 'mf-tmpmod-'))).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })

  it('two calls never hand out the same directory', () => {
    expect(mkTestDir('mf-tmpmod-')).not.toBe(mkTestDir('mf-tmpmod-'))
  })

  it('cleanupTestDirs removes every directory allocated since the last cleanup', () => {
    const a = mkTestDir('mf-tmpmod-a-')
    const b = mkTestDir('mf-tmpmod-b-')
    // Non-empty directories must go too, not just the empty ones.
    mkdirSync(join(b, 'Local Storage'), { recursive: true })

    cleanupTestDirs()

    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(false)
  })

  it('cleanupTestDirs leaves directories it did not allocate alone', () => {
    // Created behind the registry's back: it must reclaim only what it recorded, never
    // scan %TEMP% and delete a directory another process owns.
    const foreign = mkdtempSync(join(tmpdir(), 'mf-tmpmod-foreign-'))
    mkTestDir('mf-tmpmod-')

    cleanupTestDirs()

    expect(existsSync(foreign)).toBe(true)
    rmSync(foreign, { recursive: true, force: true })
  })

  it('repeated cleanup is a harmless no-op', () => {
    const dir = mkTestDir('mf-tmpmod-')
    cleanupTestDirs()

    expect(() => cleanupTestDirs()).not.toThrow()
    expect(existsSync(dir)).toBe(false)
  })
})
