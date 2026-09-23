// Single seam for every filesystem call the document IPC handlers make.
//
// The handlers' job is ORCHESTRATION (read -> detect encoding -> update the store ->
// notify the renderer), not I/O. Routing every disk access through this port keeps
// that orchestration testable: a test injects an in-memory implementation instead of
// touching a real disk, which removes the host filesystem — separator shape, case
// sensitivity, permissions, latency — as a variable in unit tests.
//
// This module is deliberately a HUMBLE ADAPTER: every method is a one-line forward to
// node:fs with no logic of its own. It is verified once against a real (temporary)
// directory in disk-io.test.ts; everything above it is tested against a fake.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  statSync,
  readdirSync,
  openSync,
  writeSync,
  closeSync,
  copyFileSync,
  promises as fsPromises,
} from 'node:fs'
import type { Dirent } from 'node:fs'

// Edge detection of the filesystem's case-sensitivity for the MAIN process.
//
// This is the ONE place in the main process that reads `process.platform` for the
// case-sensitivity rule; the pure rule itself lives in `shared/fileUtils.ts` and takes
// the result as an argument (see docs/adr/0014-*.md). The renderer has its own
// navigator-based detection because it runs in a browser context without `process.platform`.
export function isFileSystemCaseSensitive(): boolean {
  return process.platform === 'linux'
}

export interface DirEntry {
  name: string
  isDirectory: () => boolean
}

export interface FileStats {
  size: number
  birthtimeMs: number
  mtimeMs: number
}

// Async read handle, mirroring the small slice of node's FileHandle that
// `documents:eol` needs (open -> read a sample -> close, always closing even on a
// read failure).
export interface ReadHandle {
  read(maxBytes: number): Promise<Buffer>
  close(): Promise<void>
}

export interface DiskIO {
  readFile(path: string): Buffer
  writeFile(path: string, data: Buffer): void
  exists(path: string): boolean
  mkdir(path: string, options?: { recursive?: boolean }): void
  rename(oldPath: string, newPath: string): void
  stat(path: string): FileStats
  readdir(path: string): DirEntry[]
  /** True if `path` is a directory; false for files, missing paths, or anything else. */
  isDirectory(path: string): boolean
  /** Create a file that must not already exist (`wx`); rejects with EEXIST if it does. */
  openExclusive(path: string): number
  writeToFd(fd: number, content: string): void
  closeFd(fd: number): void
  openForRead(path: string): Promise<ReadHandle>
  /** Copy `src` to `dest` (atomic on real fs; fails if `src` is missing). */
  copyFile(src: string, dest: string): void
}

export const nodeDiskIO: DiskIO = {
  readFile: (path) => readFileSync(path),
  writeFile: (path, data) => writeFileSync(path, data),
  exists: (path) => existsSync(path),
  mkdir: (path, options) => mkdirSync(path, options),
  rename: (oldPath, newPath) => renameSync(oldPath, newPath),
  copyFile: (src, dest) => copyFileSync(src, dest),
  stat: (path) => {
    const st = statSync(path)
    return { size: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs }
  },
  readdir: (path) =>
    readdirSync(path, { withFileTypes: true }).map((entry: Dirent) => ({
      name: entry.name,
      isDirectory: () => entry.isDirectory(),
    })),
  isDirectory: (path) => statSync(path).isDirectory(),
  openExclusive: (path) => openSync(path, 'wx'),
  writeToFd: (fd, content) => writeSync(fd, content, undefined, 'utf-8'),
  closeFd: (fd) => closeSync(fd),
  openForRead: async (path) => {
    const handle = await fsPromises.open(path, 'r')
    return {
      read: async (maxBytes: number) => {
        const buf = Buffer.alloc(maxBytes)
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        return buf.subarray(0, bytesRead)
      },
      close: () => handle.close(),
    }
  },
}

// ─── In-memory implementation ────────────────────────────────────────────────────
//
// For unit tests. Paths here are opaque Map keys: nothing has to exist on a real disk,
// so a test can drive the handlers with ANY path shape — including Windows-shaped paths
// on Linux — which is what makes separator-handling branches reachable on every
// platform instead of only on the host they happen to run on.
//
// Deliberately a FAKE (real working behaviour over a Map), not a mock: tests assert the
// resulting state, not "which method was called how many times".
export interface MemoryDiskIO extends DiskIO {
  /**
   * Seed a file for test setup. A string is stored as UTF-8; a Buffer/Uint8Array is stored
   * VERBATIM, so a test can seed a BINARY fixture (e.g. a PNG's raw bytes) directly instead of
   * having to encode it as text — seeding `Buffer.from([1,2,3,4])` as a string would silently
   * go through UTF-8 and lose the intent (and mis-handle non-UTF-8 byte sequences).
   */
  seed(path: string, content: string | Uint8Array): void
  /** Delete a file. Test-only: production deletes go through shell.trashItem. */
  remove(path: string): void
  /** Recursive delete for test cleanup. Mirrors fsPromises.rm semantics. */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void
}

export function createMemoryDiskIO(): MemoryDiskIO {
  const files = new Map<string, Buffer>()
  const dirs = new Set<string>()
  const openFds = new Map<number, string>()
  let nextFd = 1

  // Declared as a function STATEMENT on purpose. TypeScript only treats a call as
  // never-returning (so the code after it is unreachable and `Buffer | undefined`
  // narrows) when the callee is a function declaration, or a const carrying an explicit
  // type annotation — an inferred arrow function does not.
  function fail(code: string, what: string): never {
    throw Object.assign(new Error(`${code}: ${what}`), { code })
  }

  // Windows' fs treats `/` and `\` as the same separator, and real `fs.rename`
  // recurses, so this fake mirrors both: every path key is normalised to `\` so a
  // request in either separator shape resolves to the same in-memory entry.
  const canon = (p: string) => p.replace(/\//g, '\\')

  return {
    seed(path, content) {
      files.set(
        canon(path),
        typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content),
      )
    },
    readFile(path) {
      const buf = files.get(canon(path))
      if (buf === undefined) fail('ENOENT', canon(path))
      return buf
    },
    writeFile(path, data) {
      files.set(canon(path), Buffer.from(data))
    },
    exists(path) {
      const c = canon(path)
      return files.has(c) || dirs.has(c)
    },
    mkdir(path, options) {
      const norm = canon(path).replace(/[\\/]+$/, '')
      // Default to recursive (create every ancestor) so callers that omit `options` keep
      // behaving as before. Only an EXPLICIT `{ recursive: false }` demands a non-recursive
      // create that rejects when the leaf already exists (EEXIST) or a parent is missing
      // (ENOENT) — exactly what `documents:create-folder` wants, so a name clash surfaces to
      // the renderer instead of being swallowed.
      if (options?.recursive !== false) {
        // Mirror `fs.mkdirSync(recursive: true)`: create every ancestor, not just the leaf,
        // and never throw if the leaf already exists.
        const segs = norm.split(/[\\/]/)
        let cur = segs[0]
        dirs.add(cur)
        for (let i = 1; i < segs.length; i++) {
          // `canon` has already normalised every separator to `\`, so the join is `\`.
          cur += '\\' + segs[i]
          dirs.add(cur)
        }
        return
      }
      // Non-recursive: the parent must exist and the leaf must be free.
      const segs = norm.split(/[\\/]/)
      const parent = segs.slice(0, -1).join('\\')
      // The root ('') is always present, so a top-level create never ENOENTs on it.
      if (parent !== '' && !dirs.has(parent)) fail('ENOENT', parent)
      if (dirs.has(norm) || files.has(norm)) fail('EEXIST', norm)
      dirs.add(norm)
    },
    rename(oldPath, newPath) {
      // Windows' fs treats `/` and `\` as one separator, so a request may use a
      // different separator shape than the stored keys (e.g. the renderer builds
      // tree paths with `/` on Windows where stored paths use `\`). Every key is
      // normalised to `\` on the way in (see the `canon` helper below), so both
      // sides already match.
      const oldCanon = canon(oldPath)
      const newCanon = canon(newPath)
      const buf = files.get(oldCanon)
      if (buf !== undefined) {
        files.delete(oldCanon)
        files.set(newCanon, buf)
        return
      }
      // Directory move: relocate `oldPath` and every entry beneath it (real `fs.rename`
      // recurses, so the fake must too — a folder rename would otherwise ENOENT).
      const base = oldCanon.replace(/[\\/]+$/, '')
      const matches = [...files.keys(), ...dirs].filter((p) => {
        if (p === base) return true
        const rest = p.startsWith(base) ? p.slice(base.length) : ''
        return /^[\\/]/.test(rest)
      })
      if (matches.length === 0) fail('ENOENT', oldPath)
      const targetBase = newCanon.replace(/[\\/]+$/, '')
      for (const p of matches) {
        const rel = p.slice(base.length).replace(/^[\\/]/, '')
        const np = targetBase + (rel ? '\\' + rel : '')
        if (files.has(p)) {
          files.set(np, files.get(p)!)
          files.delete(p)
        } else {
          dirs.delete(p)
          dirs.add(np)
        }
      }
    },
    copyFile(src, dest) {
      const buf = files.get(canon(src))
      if (buf === undefined) fail('ENOENT', canon(src))
      files.set(canon(dest), Buffer.from(buf))
    },
    stat(path) {
      const buf = files.get(canon(path))
      if (buf === undefined) fail('ENOENT', canon(path))
      // Timestamps are meaningless in memory; the shape matters, not the values.
      return { size: buf.length, birthtimeMs: 0, mtimeMs: 0 }
    },
    readdir(path) {
      const base = canon(path).replace(/[\\/]+$/, '')
      // Mirror `fs.readdirSync`: a missing directory must surface (the caller decides
      // whether to swallow it) rather than silently returning an empty list — real
      // fs throws here, and `documents:list-folders` relies on that to skip unreadable
      // branches instead of crashing IPC.
      const exists =
        dirs.has(base) ||
        [...files.keys(), ...dirs].some((p) => {
          const rest = p.startsWith(base) ? p.slice(base.length) : ''
          return /^[\\/]/.test(rest)
        })
      if (!exists) fail('ENOENT', base)
      const names = new Set<string>()
      for (const p of [...files.keys(), ...dirs]) {
        // A child must sit DIRECTLY under `base`: the remainder has to begin with a
        // separator. That keeps a prefix look-alike such as `/root-sibling` from being
        // mistaken for a child of `/root`, and stops `base` being its own child.
        const rest = p.startsWith(base) ? p.slice(base.length) : ''
        if (!/^[\\/]/.test(rest)) continue
        names.add(rest.replace(/^[\\/]/, '').split(/[\\/]/)[0])
      }
      return [...names]
        .filter((name) => name !== '')
        .map((name) => ({
          name,
          isDirectory: () => dirs.has(`${base}/${name}`) || dirs.has(`${base}\\${name}`),
        }))
    },
    isDirectory: (path) => dirs.has(canon(path)),
    remove(path) {
      const c = canon(path)
      if (!files.has(c)) fail('ENOENT', c)
      files.delete(c)
    },
    rm(path, options) {
      const base = canon(path).replace(/[\\/]+$/, '')
      const targets = [...files.keys(), ...dirs].filter((p) => {
        if (p === base) return true
        // A recursive rm only removes entries that sit DIRECTLY under `base`
        // (separator-bounded), so a same-prefix sibling is never swept up.
        const rest = p.startsWith(base) ? p.slice(base.length) : ''
        return options?.recursive === true && /^[\\/]/.test(rest)
      })
      if (targets.length === 0 && options?.force !== true) fail('ENOENT', path)
      for (const p of targets) {
        files.delete(p)
        dirs.delete(p)
      }
    },
    openExclusive(path) {
      // A NUL byte makes the path un-openable on every real platform (not a name
      // collision), so the create retry loop must surface it — mirror that here.
      const c = canon(path)
      if (c.includes('\0')) fail('EINVAL', c)
      if (dirs.has(c)) fail('EISDIR', c)
      if (files.has(c)) fail('EEXIST', c)
      const fd = nextFd++
      openFds.set(fd, c)
      files.set(c, Buffer.alloc(0))
      return fd
    },
    writeToFd(fd, content) {
      const path = openFds.get(fd)
      if (path === undefined) fail('EBADF', String(fd))
      files.set(path, Buffer.from(content, 'utf-8'))
    },
    closeFd(fd) {
      openFds.delete(fd)
    },
    async openForRead(path) {
      const buf = files.get(canon(path))
      if (buf === undefined) fail('ENOENT', canon(path))
      return {
        async read(maxBytes: number) {
          return buf.subarray(0, maxBytes)
        },
        async close() {
          /* nothing to release */
        },
      }
    },
  }
}
