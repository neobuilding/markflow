import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolve, join } from 'node:path'
import { createMemoryDiskIO } from '../lib/disk-io'

// This handler must be a genuine unit test: it exercises orchestration against the
// in-memory DiskIO fake and never touches a real disk (the old version created real
// temp directories — that belongs to e2e, not a handler unit test).
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
  let io: ReturnType<typeof createMemoryDiskIO>
  let root: string
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    io = createMemoryDiskIO()
    // `resolve` produces an absolute path the handler will re-resolve; seed the
    // in-memory disk at exactly that path so the fake and the handler agree.
    root = resolve('mf-files-root')
    registerFilesHandlers(io)
  })

  function seed(files: string[]): void {
    io.mkdir(root)
    for (const f of files) io.seed(join(root, f), '# ' + f)
  }

  it('returns [] for no paths', () => {
    expect(handlers['files:resolve-paths'](null, [])).toEqual({
      directories: [],
      markdownFiles: [],
    })
  })

  it('expands a directory into its markdown files', () => {
    seed(['a.md', 'b.txt'])
    const out = handlers['files:resolve-paths'](null, [root]) as {
      directories: string[]
      markdownFiles: string[]
    }
    expect(out.directories).toContain(root)
    expect(out.markdownFiles).toContain(join(root, 'a.md'))
    expect(out.markdownFiles).not.toContain(join(root, 'b.txt'))
  })

  it('for a single .md file, also imports siblings in its directory', () => {
    seed(['a.md', 'sibling.md'])
    const out = handlers['files:resolve-paths'](null, [join(root, 'a.md')]) as {
      directories: string[]
      markdownFiles: string[]
    }
    expect(out.markdownFiles).toContain(join(root, 'a.md'))
    expect(out.markdownFiles).toContain(join(root, 'sibling.md'))
    expect(out.directories).toContain(root)
  })

  it('ignores non-markdown single files', () => {
    seed(['x.txt'])
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
    seed(['a.md', 'sibling.md'])
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
