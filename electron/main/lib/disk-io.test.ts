// @vitest-environment node
//
// The ONE place a real filesystem is touched on purpose.
//
// `nodeDiskIO` is a humble adapter: every method is a one-line forward to node:fs.
// Verifying it against a real (temporary) directory once proves the forwards are not
// written backwards; everything built on top of it is then tested against an
// in-memory fake. Scoped to a fresh temp dir per run, and nothing outside it is touched.
import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTestDir } from '../test-support/tmp'
import { createMemoryDiskIO, nodeDiskIO, isFileSystemCaseSensitive } from './disk-io'

const root = mkTestDir('mf-diskio-')

describe('nodeDiskIO', () => {
  it('writes and reads a file as a Buffer', () => {
    const p = join(root, 'a.bin')
    nodeDiskIO.writeFile(p, Buffer.from('hello'))
    expect(nodeDiskIO.readFile(p).toString('utf-8')).toBe('hello')
    expect(nodeDiskIO.exists(p)).toBe(true)
    expect(nodeDiskIO.exists(join(root, 'nope'))).toBe(false)
  })

  it('creates directories, with and without the recursive option', () => {
    const nested = join(root, 'x', 'y')
    nodeDiskIO.mkdir(nested, { recursive: true })
    expect(nodeDiskIO.exists(nested)).toBe(true)

    const flat = join(root, 'flat')
    nodeDiskIO.mkdir(flat)
    expect(nodeDiskIO.exists(flat)).toBe(true)
  })

  it('renames a file', () => {
    const from = join(root, 'r1.txt')
    const to = join(root, 'r2.txt')
    writeFileSync(from, 'x')
    nodeDiskIO.rename(from, to)
    expect(nodeDiskIO.exists(from)).toBe(false)
    expect(nodeDiskIO.exists(to)).toBe(true)
  })

  it('reports size and timestamps', () => {
    const p = join(root, 's.txt')
    writeFileSync(p, '12345')
    const st = nodeDiskIO.stat(p)
    expect(st.size).toBe(5)
    expect(st.mtimeMs).toBeGreaterThan(0)
    expect(typeof st.birthtimeMs).toBe('number')
  })

  it('lists entries and says which of them are directories', () => {
    const dir = join(root, 'list')
    nodeDiskIO.mkdir(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'f.txt'), 'x')

    const entries = nodeDiskIO.readdir(dir)
    expect(entries.map((e) => e.name).sort()).toEqual(['f.txt', 'sub'])
    expect(entries.find((e) => e.name === 'sub')?.isDirectory()).toBe(true)
    expect(entries.find((e) => e.name === 'f.txt')?.isDirectory()).toBe(false)
  })

  it('creates a file exclusively and reports EEXIST once it is taken', () => {
    const p = join(root, 'excl.txt')
    const fd = nodeDiskIO.openExclusive(p)
    nodeDiskIO.writeToFd(fd, 'body')
    nodeDiskIO.closeFd(fd)
    expect(nodeDiskIO.readFile(p).toString('utf-8')).toBe('body')
    expect(() => nodeDiskIO.openExclusive(p)).toThrow(/EEXIST/)
  })

  it('reads a bounded sample through an async handle and closes it', async () => {
    const p = join(root, 'sample.txt')
    writeFileSync(p, 'ab\r\ncd')

    const first = await nodeDiskIO.openForRead(p)
    try {
      expect((await first.read(65536)).toString('utf-8')).toBe('ab\r\ncd')
    } finally {
      await first.close()
    }

    // A shorter bound truncates instead of failing.
    const second = await nodeDiskIO.openForRead(p)
    try {
      expect((await second.read(3)).toString('utf-8')).toBe('ab\r')
    } finally {
      await second.close()
    }
  })
})

describe('createMemoryDiskIO', () => {
  it('seeds, reads and writes files', () => {
    const io = createMemoryDiskIO()
    io.seed('/a/x.md', 'hello')
    expect(io.readFile('/a/x.md').toString('utf-8')).toBe('hello')

    io.writeFile('/a/y.md', Buffer.from('bye'))
    expect(io.readFile('/a/y.md').toString('utf-8')).toBe('bye')

    expect(io.exists('/a/x.md')).toBe(true)
    expect(io.exists('/a/nope')).toBe(false)
    expect(() => io.readFile('/a/nope')).toThrow(/ENOENT/)
  })

  it('tracks directories and renames', () => {
    const io = createMemoryDiskIO()
    io.mkdir('/docs')
    expect(io.exists('/docs')).toBe(true)

    io.seed('/docs/a.md', 'x')
    io.rename('/docs/a.md', '/docs/b.md')
    expect(io.exists('/docs/a.md')).toBe(false)
    expect(io.readFile('/docs/b.md').toString('utf-8')).toBe('x')
    expect(() => io.rename('/docs/missing.md', '/docs/c.md')).toThrow(/ENOENT/)
  })

  it('rename recurses a whole directory tree (folder move)', () => {
    const io = createMemoryDiskIO()
    io.mkdir('/tree/sub')
    io.seed('/tree/a.md', 'x')
    io.seed('/tree/sub/b.md', 'y')
    io.rename('/tree', '/moved')
    expect(io.exists('/tree')).toBe(false)
    expect(io.exists('/moved/a.md')).toBe(true)
    expect(io.readFile('/moved/a.md').toString('utf-8')).toBe('x')
    expect(io.readFile('/moved/sub/b.md').toString('utf-8')).toBe('y')
  })

  it('mkdir creates every ancestor, like fs.mkdirSync(recursive: true)', () => {
    const io = createMemoryDiskIO()
    io.mkdir('C:\\win\\sub\\deeper')
    io.writeFile('C:\\win\\a.md', Buffer.from('a'))
    // The leaf dir exists, and so do its (implicit) parents.
    expect(io.exists('C:\\win')).toBe(true)
    expect(io.exists('C:\\win\\sub')).toBe(true)
    expect(io.exists('C:\\win\\sub\\deeper')).toBe(true)
    // readdir now reports `sub` as a directory because the parent entry is present.
    const entries = io.readdir('C:\\win')
    expect(entries.map((e) => e.name).sort()).toEqual(['a.md', 'sub'])
    expect(entries.find((e) => e.name === 'sub')?.isDirectory()).toBe(true)
  })

  it('mkdir without recursion rejects EEXIST on an existing leaf and ENOENT on a missing parent', () => {
    const io = createMemoryDiskIO()
    io.mkdir('/docs', { recursive: true })
    // An existing leaf must surface (mirrors fs.mkdirSync non-recursive), not be swallowed.
    expect(() => io.mkdir('/docs', { recursive: false })).toThrow(/EEXIST/)
    // A missing parent must surface too, instead of silently creating ancestors.
    expect(() => io.mkdir('/absent/sub', { recursive: false })).toThrow(/ENOENT/)
    // A free leaf under an existing parent succeeds.
    expect(() => io.mkdir('/docs/sub', { recursive: false })).not.toThrow()
    expect(io.exists('/docs/sub')).toBe(true)
  })

  it('mkdir without recursion rejects EEXIST when a FILE already holds the name', () => {
    const io = createMemoryDiskIO()
    io.mkdir('/docs', { recursive: true })
    io.writeFile('/docs/note.md', Buffer.from('hi'))
    // A name collision with a file (not just a directory) must also be refused.
    expect(() => io.mkdir('/docs/note.md', { recursive: false })).toThrow(/EEXIST/)
  })

  it('stat reports size and rejects a missing path', () => {
    const io = createMemoryDiskIO()
    io.seed('/a.md', '12345')
    expect(io.stat('/a.md').size).toBe(5)
    expect(() => io.stat('/nope.md')).toThrow(/ENOENT/)
  })

  it('lists direct children and marks which are directories', () => {
    const io = createMemoryDiskIO()
    io.mkdir('/root') // the listed dir itself: must not show up as its own child
    io.mkdir('/root/sub')
    io.seed('/root/f.md', 'x')
    io.seed('/root/sub/deep.md', 'y')
    io.seed('/other/z.md', 'z') // elsewhere entirely
    io.mkdir('/root-sibling') // prefix look-alike: must not be listed under /root

    const entries = io.readdir('/root')
    expect(entries.map((e) => e.name).sort()).toEqual(['f.md', 'sub'])
    expect(entries.find((e) => e.name === 'sub')?.isDirectory()).toBe(true)
    expect(entries.find((e) => e.name === 'f.md')?.isDirectory()).toBe(false)
  })

  it('handles Windows-shaped trees (backslash separator)', () => {
    const io = createMemoryDiskIO()
    io.mkdir('C:\\win\\nested')
    io.seed('C:\\win\\a.md', 'x')

    const entries = io.readdir('C:\\win')
    expect(entries.map((e) => e.name).sort()).toEqual(['a.md', 'nested'])
    // Exercises the backslash half of the isDirectory check.
    expect(entries.find((e) => e.name === 'nested')?.isDirectory()).toBe(true)
    expect(entries.find((e) => e.name === 'a.md')?.isDirectory()).toBe(false)
  })

  it('readdir throws ENOENT for a missing directory (mirrors fs.readdirSync)', () => {
    const io = createMemoryDiskIO()
    io.seed('/gone2.md', 'x') // a sibling whose name merely starts with '/gone'
    io.seed('/other.md', 'x') // an unrelated entry
    expect(() => io.readdir('/gone')).toThrow(/ENOENT/)
  })

  it('creates exclusively, writes through the fd and closes it', () => {
    const io = createMemoryDiskIO()
    const fd = io.openExclusive('/new.md')
    io.writeToFd(fd, 'body')
    io.closeFd(fd)
    expect(io.readFile('/new.md').toString('utf-8')).toBe('body')

    expect(() => io.openExclusive('/new.md')).toThrow(/EEXIST/)
    expect(() => io.writeToFd(999, 'x')).toThrow(/EBADF/)
  })

  it('openExclusive rejects a directory or an invalid (NUL) path', () => {
    const io = createMemoryDiskIO()
    io.mkdir('/d')
    expect(() => io.openExclusive('/d')).toThrow(/EISDIR/)
    // A NUL byte is un-openable on every platform — not a name collision — so the
    // create retry loop can surface it instead of spinning on `-1`, `-2`, ...
    expect(() => io.openExclusive('a\u0000b.md')).toThrow(/EINVAL/)
  })

  it('reads a bounded sample through an async handle', async () => {
    const io = createMemoryDiskIO()
    io.seed('/sample.md', 'ab\r\ncd')

    const handle = await io.openForRead('/sample.md')
    expect((await handle.read(3)).toString('utf-8')).toBe('ab\r')
    await handle.close()

    await expect(io.openForRead('/nope.md')).rejects.toThrow(/ENOENT/)
  })

  it('removes a file and rejects a missing one', () => {
    const io = createMemoryDiskIO()
    io.seed('/a.md', 'x')
    io.remove('/a.md')
    expect(io.exists('/a.md')).toBe(false)
    expect(() => io.remove('/a.md')).toThrow(/ENOENT/)
  })

  it('recursively removes a directory tree but never a same-prefix sibling', () => {
    const io = createMemoryDiskIO()
    io.seed('/tree/sub/deep.md', 'y')
    io.mkdir('/tree')
    io.mkdir('/tree-sibling')

    // Without recursive, only the exact path (and nothing under it) is wiped.
    io.rm('/tree', { recursive: false })
    expect(io.exists('/tree/sub/deep.md')).toBe(true)

    io.rm('/tree', { recursive: true })
    expect(io.exists('/tree/sub/deep.md')).toBe(false)
    // The separator-bounded check keeps the look-alike sibling intact.
    expect(io.exists('/tree-sibling')).toBe(true)
  })

  it('rm with force tolerates a missing path', () => {
    const io = createMemoryDiskIO()
    expect(() => io.rm('/gone', { recursive: true })).toThrow(/ENOENT/)
    expect(() => io.rm('/gone', { recursive: true, force: true })).not.toThrow()
  })
})

describe('isFileSystemCaseSensitive', () => {
  const original = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  })

  it('is true on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(isFileSystemCaseSensitive()).toBe(true)
  })

  it('is false on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(isFileSystemCaseSensitive()).toBe(false)
  })

  it('is false on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(isFileSystemCaseSensitive()).toBe(false)
  })
})
