// @vitest-environment node
//
// The ONE place a real filesystem is touched on purpose.
//
// `nodeDiskIO` is a humble adapter: every method is a one-line forward to node:fs.
// Verifying it against a real (temporary) directory once proves the forwards are not
// written backwards; everything built on top of it is then tested against an
// in-memory fake. Scoped to a fresh temp dir per run, and nothing outside it is touched.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryDiskIO, nodeDiskIO } from './disk-io'

const root = mkdtempSync(join(tmpdir(), 'mf-diskio-'))

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

  it('reports size and rejects stat on a missing file', () => {
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

  it('creates exclusively, writes through the fd and closes it', () => {
    const io = createMemoryDiskIO()
    const fd = io.openExclusive('/new.md')
    io.writeToFd(fd, 'body')
    io.closeFd(fd)
    expect(io.readFile('/new.md').toString('utf-8')).toBe('body')

    expect(() => io.openExclusive('/new.md')).toThrow(/EEXIST/)
    expect(() => io.writeToFd(999, 'x')).toThrow(/EBADF/)
  })

  it('reads a bounded sample through an async handle', async () => {
    const io = createMemoryDiskIO()
    io.seed('/sample.md', 'ab\r\ncd')

    const handle = await io.openForRead('/sample.md')
    expect((await handle.read(3)).toString('utf-8')).toBe('ab\r')
    await handle.close()

    await expect(io.openForRead('/nope.md')).rejects.toThrow(/ENOENT/)
  })
})
