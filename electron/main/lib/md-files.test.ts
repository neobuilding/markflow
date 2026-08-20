import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Expose a mutable flag so each test can flip app.isPackaged before importing the
// module under test (mirrors the hoisted-fake pattern used by lifecycle.test.ts).
const h = vi.hoisted(() => ({ isPackaged: false }))

vi.mock('electron', () => ({
  // Use a getter so extractArgvPaths() reads the *current* h.isPackaged at call time,
  // instead of the value captured when the module was first imported.
  app: {
    get isPackaged() {
      return h.isPackaged
    },
  },
}))

// Re-import the module under test.
async function loadMdFiles() {
  return import('./md-files.js')
}

describe('md-files — MD_EXTS', () => {
  it('covers the supported markdown extensions', async () => {
    const { MD_EXTS } = await loadMdFiles()
    expect([...MD_EXTS].sort()).toEqual(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'].sort())
  })
})

describe('md-files — collectMarkdownFiles', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mf-md-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('recursively collects markdown files and skips hidden dirs + node_modules', async () => {
    const { collectMarkdownFiles } = await loadMdFiles()

    writeFileSync(join(root, 'a.md'), '# a')
    writeFileSync(join(root, 'b.markdown'), '# b')
    writeFileSync(join(root, 'ignore.txt'), 'x')

    const nested = join(root, 'nested', 'deep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'c.mdx'), '# c')

    // hidden dir + node_modules must be skipped
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'secret.md'), '# secret')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'dep.md'), '# dep')

    const found = collectMarkdownFiles(root).sort()
    expect(found).toEqual(
      [join(root, 'a.md'), join(nested, 'c.mdx'), join(root, 'b.markdown')].sort(),
    )
  })

  it('returns an empty array for an unreadable path', async () => {
    const { collectMarkdownFiles } = await loadMdFiles()
    expect(collectMarkdownFiles(join(root, 'does-not-exist'))).toEqual([])
  })

  it('ignores files without a markdown extension (no-dot filename branch)', async () => {
    const { collectMarkdownFiles } = await loadMdFiles()
    // A file with no extension at all: name.lastIndexOf('.') === -1, so the
    // derived ext is the whole name and never matches MD_EXTS.
    writeFileSync(join(root, 'README'), '# readme')
    writeFileSync(join(root, 'notes'), 'plain')
    // A file whose "extension" case doesn't match (e.g. uppercase) is lowercased.
    writeFileSync(join(root, 'ok.MD'), '# ok')
    const found = collectMarkdownFiles(root).sort()
    // Only the lowercased .MD match is collected; extensionless files are skipped.
    expect(found).toEqual([join(root, 'ok.MD')])
  })
})

describe('md-files — extractArgvPaths', () => {
  it('returns [] in dev mode (app.isPackaged === false)', async () => {
    h.isPackaged = false
    const { extractArgvPaths } = await loadMdFiles()
    // In dev, argv is never treated as document paths regardless of what is passed.
    const tmp = mkdtempSync(join(tmpdir(), 'mf-argv-dev-'))
    try {
      const md = join(tmp, 'doc.md')
      writeFileSync(md, '# d')
      expect(extractArgvPaths([md, '/usr/bin/electron', '-flag', 'file:///x'])).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('filters by extension and skips flags / urls / scripts in packaged mode', async () => {
    h.isPackaged = true
    const { extractArgvPaths } = await loadMdFiles()
    const tmp = mkdtempSync(join(tmpdir(), 'mf-argv2-'))
    try {
      const md = join(tmp, 'doc.md')
      writeFileSync(md, '# d')
      const other = join(tmp, 'note.txt')
      writeFileSync(other, 'x')
      // Mix a real .md file with items that must be filtered out: an Electron flag,
      // a .js script, a file:// URL, and a non-markdown file.
      const out = extractArgvPaths([
        md,
        other,
        '-flag',
        'script.js',
        'file:///x',
        '/usr/bin/electron',
      ])
      expect(out).toEqual([md])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('keeps existing files/dirs, drops unreadable args', async () => {
    h.isPackaged = true
    const { extractArgvPaths } = await loadMdFiles()
    const tmp = mkdtempSync(join(tmpdir(), 'mf-argv-'))
    try {
      const f = join(tmp, 'real.md')
      writeFileSync(f, '# r')
      const dir = join(tmp, 'realdir')
      mkdirSync(dir, { recursive: true })
      const out = extractArgvPaths([f, dir, join(tmp, 'ghost.md')])
      expect(out).toContain(f)
      expect(out).toContain(dir)
      expect(out.some((p) => p.includes('ghost.md'))).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('skips existent files whose name has no markdown extension (no-dot branch)', async () => {
    h.isPackaged = true
    const { extractArgvPaths } = await loadMdFiles()
    const tmp = mkdtempSync(join(tmpdir(), 'mf-argv-nodot-'))
    try {
      // A plain file with no dot: arg.lastIndexOf('.') === -1, so the derived ext
      // is the whole name and is not in MD_EXTS -> skipped even though it exists.
      const plain = join(tmp, 'LICENSE')
      writeFileSync(plain, 'MIT')
      // A matching markdown file should still be picked up.
      const md = join(tmp, 'doc.md')
      writeFileSync(md, '# d')
      const out = extractArgvPaths([plain, md])
      expect(out).toEqual([md])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
