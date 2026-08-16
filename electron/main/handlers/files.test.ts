import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      handlers[ch] = fn
    },
  },
}))

import { registerFilesHandlers } from './files'

describe('files handlers', () => {
  let root: string
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    root = mkdtempSync(join(tmpdir(), 'mf-files-'))
    registerFilesHandlers()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns [] for no paths', () => {
    expect(handlers['files:resolve-paths'](null, [])).toEqual({
      directories: [],
      markdownFiles: [],
    })
  })

  it('expands a directory into its markdown files', () => {
    writeFileSync(join(root, 'a.md'), '# a')
    writeFileSync(join(root, 'b.txt'), 'ignore')
    const out = handlers['files:resolve-paths'](null, [root]) as {
      directories: string[]
      markdownFiles: string[]
    }
    expect(out.directories).toContain(root)
    expect(out.markdownFiles).toContain(join(root, 'a.md'))
    expect(out.markdownFiles).not.toContain(join(root, 'b.txt'))
  })

  it('for a single .md file, also imports siblings in its directory', () => {
    writeFileSync(join(root, 'a.md'), '# a')
    writeFileSync(join(root, 'sibling.md'), '# s')
    const out = handlers['files:resolve-paths'](null, [join(root, 'a.md')]) as {
      directories: string[]
      markdownFiles: string[]
    }
    expect(out.markdownFiles).toContain(join(root, 'a.md'))
    expect(out.markdownFiles).toContain(join(root, 'sibling.md'))
    expect(out.directories).toContain(root)
  })

  it('ignores non-markdown single files', () => {
    writeFileSync(join(root, 'x.txt'), 'no')
    const out = handlers['files:resolve-paths'](null, [join(root, 'x.txt')]) as {
      directories: string[]
      markdownFiles: string[]
    }
    expect(out.markdownFiles).toEqual([])
  })

  it('skips inaccessible paths without throwing', () => {
    expect(() => handlers['files:resolve-paths'](null, ['/no/such/path/that/exists'])).not.toThrow()
  })

  it('does not duplicate a directory already added via a sibling file', () => {
    writeFileSync(join(root, 'a.md'), '# a')
    writeFileSync(join(root, 'sibling.md'), '# s')
    // Pass the directory AND a file inside it in the same call; the parent dir
    // must only appear once (exercises the !directories.includes(parentDir) false branch).
    const out = handlers['files:resolve-paths'](null, [root, join(root, 'a.md')]) as {
      directories: string[]
      markdownFiles: string[]
    }
    const dirCount = out.directories.filter((d) => d === root).length
    expect(dirCount).toBe(1)
    expect(out.markdownFiles).toContain(join(root, 'a.md'))
    expect(out.markdownFiles).toContain(join(root, 'sibling.md'))
  })
})
