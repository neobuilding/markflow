// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { addOpenFolder, clearOpenFolders, getOpenFolders } from './openFolders'

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

beforeEach(() => {
  clearOpenFolders()
})

describe('openFolders', () => {
  it('starts empty', () => {
    expect(getOpenFolders()).toEqual([])
  })

  it('remembers a folder that was opened, verbatim', () => {
    const dir = tmpDir('of-add-')
    expect(addOpenFolder(dir)).toBe(true)
    expect(getOpenFolders()).toEqual([dir])
  })

  it('returns a copy, so callers cannot mutate the set', () => {
    const dir = tmpDir('of-copy-')
    addOpenFolder(dir)
    const snapshot = getOpenFolders()
    snapshot.push('/tampered')
    expect(getOpenFolders()).toEqual([dir])
  })

  it('remembers several unrelated folders in order', () => {
    const a = tmpDir('of-a-')
    const b = tmpDir('of-b-')
    addOpenFolder(a)
    addOpenFolder(b)
    expect(getOpenFolders()).toEqual([a, b])
  })

  it('rejects a folder already covered by one being watched (drilling into a subfolder)', () => {
    const root = tmpDir('of-root-')
    addOpenFolder(root)
    expect(addOpenFolder(join(root, 'nested'))).toBe(false)
    expect(getOpenFolders()).toEqual([root])
  })

  it('recognises a covered folder despite a trailing separator or different slash style', () => {
    const root = tmpDir('of-slash-')
    addOpenFolder(root)
    expect(addOpenFolder(root.replace(/\\/g, '/') + '/')).toBe(false)
    expect(getOpenFolders()).toEqual([root])
  })

  it('does not treat sibling folders with a shared prefix as nested', () => {
    const a = tmpDir('of-prefix-a-')
    addOpenFolder(a)
    expect(addOpenFolder(a + '-sibling')).toBe(true)
    expect(getOpenFolders()).toHaveLength(2)
  })

  it('treats the folder itself as covered by itself', () => {
    const dir = tmpDir('of-self-')
    addOpenFolder(dir)
    expect(addOpenFolder(dir)).toBe(false)
    expect(getOpenFolders()).toEqual([dir])
  })

  it('drops a narrower folder when a broader one is opened', () => {
    const root = tmpDir('of-broad-')
    const nested = join(root, 'nested')
    mkdirSync(nested, { recursive: true })
    addOpenFolder(nested)
    addOpenFolder(root)
    // Only the broader folder remains: watching it covers the nested one.
    expect(getOpenFolders()).toEqual([root])
  })

  it('compares folders case-insensitively (Windows / macOS path semantics)', () => {
    const root = resolve(tmpDir('of-case-'))
    addOpenFolder(root)
    expect(addOpenFolder(root.toUpperCase())).toBe(false)
    expect(getOpenFolders()).toEqual([root])
  })

  it('ignores an empty path', () => {
    expect(addOpenFolder('')).toBe(false)
    expect(getOpenFolders()).toEqual([])
  })

  it('forgets everything on clear, and can be reused afterwards', () => {
    const dir = tmpDir('of-clear-')
    addOpenFolder(dir)
    clearOpenFolders()
    expect(getOpenFolders()).toEqual([])
    expect(addOpenFolder(dir)).toBe(true)
    expect(getOpenFolders()).toEqual([dir])
  })
})
