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
  promises as fsPromises,
} from 'node:fs'
import type { Dirent } from 'node:fs'

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
  /** Create a file that must not already exist (`wx`); rejects with EEXIST if it does. */
  openExclusive(path: string): number
  writeToFd(fd: number, content: string): void
  closeFd(fd: number): void
  openForRead(path: string): Promise<ReadHandle>
}

export const nodeDiskIO: DiskIO = {
  readFile: (path) => readFileSync(path),
  writeFile: (path, data) => writeFileSync(path, data),
  exists: (path) => existsSync(path),
  mkdir: (path, options) => mkdirSync(path, options),
  rename: (oldPath, newPath) => renameSync(oldPath, newPath),
  stat: (path) => {
    const st = statSync(path)
    return { size: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs }
  },
  readdir: (path) =>
    readdirSync(path, { withFileTypes: true }).map((entry: Dirent) => ({
      name: entry.name,
      isDirectory: () => entry.isDirectory(),
    })),
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
  /** Seed a UTF-8 file, for test setup. */
  seed(path: string, content: string): void
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

  return {
    seed(path, content) {
      files.set(path, Buffer.from(content, 'utf-8'))
    },
    readFile(path) {
      const buf = files.get(path)
      if (buf === undefined) fail('ENOENT', path)
      return buf
    },
    writeFile(path, data) {
      files.set(path, Buffer.from(data))
    },
    exists(path) {
      return files.has(path) || dirs.has(path)
    },
    mkdir(path) {
      dirs.add(path)
    },
    rename(oldPath, newPath) {
      const buf = files.get(oldPath)
      if (buf === undefined) fail('ENOENT', oldPath)
      files.delete(oldPath)
      files.set(newPath, buf)
    },
    stat(path) {
      const buf = files.get(path)
      if (buf === undefined) fail('ENOENT', path)
      // Timestamps are meaningless in memory; the shape matters, not the values.
      return { size: buf.length, birthtimeMs: 0, mtimeMs: 0 }
    },
    readdir(path) {
      const base = path.replace(/[\\/]+$/, '')
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
    openExclusive(path) {
      if (files.has(path)) fail('EEXIST', path)
      const fd = nextFd++
      openFds.set(fd, path)
      files.set(path, Buffer.alloc(0))
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
      const buf = files.get(path)
      if (buf === undefined) fail('ENOENT', path)
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
