import { describe, it, expect, vi } from 'vitest'

// Isolate the hard-to-reach branch where a directory entry is neither a
// directory nor a regular file (e.g. a symlink/special file): in that case
// statSync() succeeds but both st.isDirectory() and st.isFile() are false,
// and the entry must be silently skipped. We mock node:fs to force that path.
const h = vi.hoisted(() => ({
  isPackaged: true,
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.isPackaged
    },
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => h.readdirSync(...(args as [string])),
    statSync: (...args: unknown[]) => h.statSync(...(args as [string])),
  }
})

async function loadMdFiles() {
  return import('../md-files.js')
}

describe('md-files — non-dir/non-file entries are skipped', () => {
  it('collectMarkdownFiles skips an entry that is neither dir nor file', async () => {
    h.readdirSync.mockReturnValue(['special-node'])
    h.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => false })
    const { collectMarkdownFiles } = await loadMdFiles()
    expect(collectMarkdownFiles('/some/dir')).toEqual([])
  })

  it('extractArgvPaths skips a path that is neither dir nor file', async () => {
    h.isPackaged = true
    h.readdirSync.mockReturnValue([])
    h.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => false })
    const { extractArgvPaths } = await loadMdFiles()
    // Pass argv with an entry at index >= 2 that resolves to a (mocked) path
    // which is neither directory nor file, so it must be dropped.
    expect(extractArgvPaths(['node', 'markflow', '/some/special'])).toEqual([])
  })
})
