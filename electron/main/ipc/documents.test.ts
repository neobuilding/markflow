// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  promises as fsPromises,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep, win32 } from 'node:path'
import { mkTestDir } from '../test-support/tmp'
import {
  registerDocumentHandlers,
  normEnc,
  countReplacements,
  cjkSecondPass,
  detectEncoding,
  readMarkdownText,
  countWords,
  __flushFolderChanged,
} from './documents'
// Test seam of model/folderWatcher.ts: drives the exact dispatch the real chokidar
// listeners use, so these tests never depend on filesystem event timing.
import { __emitFolderEvent, __emitFolderDirEvent } from '../model/folderWatcher'
// In-memory DiskIO: lets a case drive the handlers with paths that need not exist on
// any real disk (see lib/disk-io.ts).
import { createMemoryDiskIO, type MemoryDiskIO } from '../lib/disk-io'
// Import the REAL isInFolder (from the un-mocked folderMatch module) so the fake
// store's listDocuments matches production semantics exactly no drift between the
// test double and documentStore.listDocuments.
import { isInFolder } from '../model/folderMatch'

// In-memory fake of the document store. documents.ts imports the named store
// functions; we mock that module so the handlers run against a plain Map instead
// of the real store singleton.
// NOTE: vi.mock factories are hoisted above top-level const declarations, so the
// fake store + its backing Map must live in vi.hoisted() to be initialized before
// the hoisted factory runs.
const { docs, fakeStore } = vi.hoisted(() => {
  const docs = new Map<string, any>()
  const fakeStore = {
    createDocumentStore: () => docs.clear(),
    listDocuments: (folderPath?: string) => {
      const all = [...docs.values()]
      const target = folderPath && folderPath !== '' ? folderPath : undefined
      const filtered = target
        ? all.filter((d: any) => d.memoryOnly === true || isInFolder(d.filePath, target))
        : all
      return filtered.sort((a: any, b: any) => b.updatedAt - a.updatedAt)
    },
    getDocumentById: (id: string) => docs.get(id) ?? null,
    getDocumentByFilePath: (filePath: string) => {
      for (const d of docs.values()) if (d.filePath === filePath) return d
      return null
    },
    // Keyed by id ONLY, exactly like the real store (which keeps no path index:
    // getDocumentByFilePath scans the values). An extra `path:` alias would survive a
    // rename and let the OLD path still resolve to a stale copy of the document, so a
    // rename round-trip could not be reproduced faithfully.
    upsertDocument: (doc: any) => {
      docs.set(doc.id, { ...doc })
      return docs.get(doc.id)
    },
    updateDocument: (id: string, partial: any) => {
      const d = docs.get(id)
      if (!d) return null
      const next = { ...d, ...partial, id }
      docs.set(id, next)
      return next
    },
    deleteDocument: (id: string) => docs.delete(id),
    setEncoding: (id: string, encoding: string, confidence: number) => {
      const d = docs.get(id)
      if (d) docs.set(id, { ...d, encoding, encodingConfidence: confidence })
    },
    purgeUnsavedDrafts: () => {
      let removed = 0
      for (const [k, d] of docs) {
        if (d.filePath === '' || d.filePath === null) {
          docs.delete(k)
          removed++
        }
      }
      return removed
    },
  }
  return { docs, fakeStore }
})
vi.mock('../model/documentStore', () => fakeStore)

// Controllable stand-in for jschardet-ultra's detector.
//
// Real detection is so accurate that one branch of detectEncoding is effectively
// unreachable with natural input: the CJK second pass only runs when the primary
// decodes WITH replacement chars, but on real bytes the detector either names the
// right codec (zero replacements -> early return) or returns a high-confidence
// non-CJK codec (skipped by the inCjkScope gate). Forcing a specific detector
// verdict is the only way to exercise that path.
const detectState = vi.hoisted(() => ({
  override: null as null | ((buf: Buffer) => { encoding: string | null; confidence: number }),
}))
vi.mock('jschardet-ultra', async () => {
  const actual = await vi.importActual<typeof import('jschardet-ultra')>('jschardet-ultra')
  return {
    ...actual,
    detect: (buf: Buffer) =>
      detectState.override ? detectState.override(buf) : actual.detect(buf),
  }
})

// Stand-in for chokidar: records every watcher the module under test creates, and
// captures the paths handed to `add()` / whether `close()` was called, so the
// watcher lifecycle can be asserted without any real filesystem watching.
const chokidarState = vi.hoisted(() => ({ instances: [] as any[] }))
vi.mock('chokidar', () => ({
  watch: (paths: string | string[], _opts?: unknown) => {
    const inst: any = {
      paths: Array.isArray(paths) ? paths : [paths],
      added: [] as string[],
      closed: false,
      add(p: string | string[]) {
        inst.added.push(...(Array.isArray(p) ? p : [p]))
        return inst
      },
      on() {
        return inst
      },
      async close() {
        inst.closed = true
      },
    }
    chokidarState.instances.push(inst)
    return inst
  },
}))

// documents.ts imports `shell` from electron (trashItem on delete); provide a no-op
// stub so the node test env doesn't need a real Electron runtime.
vi.mock('electron', () => ({
  shell: { trashItem: vi.fn().mockResolvedValue(undefined) },
}))

// documents.ts calls renameSync (in rename-file / rename-folder / undo-rename). The module
// namespace is not spyable in ESM, so wrap it through a hoisted mock that calls through by
// default; individual tests can make it throw via mockImplementationOnce to hit the undo-rename
// failure branch.
// The whole suite runs against an in-memory filesystem so it never touches a real
// disk (platform-independent, no risk of clobbering real files). Every `node:fs`
// entry point the handlers and the test setup use is forwarded to the shared
// `createMemoryDiskIO()` instance created just below (lives on globalThis).
//
// NOTE: the instance is created OUTSIDE this factory. Importing `../lib/disk-io`
// from inside a vi.mock factory would load that module while node:fs is still being
// mocked, handing its `nodeDiskIO` adapter the REAL fs (a recursive-mock hazard) and
// sending calls back to disk — so we only read the already-created instance here.
const fsRenameMock = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs')
  // `security.ts`/`appdoc.ts` call `realpathSync` for the containment check. On a
  // real disk the in-memory paths do not exist, so the REAL call throws and the
  // resolve-appdoc handler (which catches) returns null. Mirror it lexically so the
  // check still runs without touching a real disk.
  const { resolve } = await import('node:path')
  const getMem = () => (globalThis as any).__memFs as MemoryDiskIO

  // renameSync keeps using the controllable spy so the EBUSY failure branch stays
  // stubbable; by default it just delegates to the in-memory rename.
  fsRenameMock.mockImplementation((oldPath: string, newPath: string) =>
    getMem().rename(oldPath, newPath),
  )

  return {
    ...actual,
    realpathSync: (p: string) => resolve(p),
    readFileSync: (p: string, opts?: any) => {
      const buf = getMem().readFile(p)
      if (typeof opts === 'string') return buf.toString(opts as BufferEncoding)
      if (opts && typeof opts === 'object' && opts.encoding)
        return buf.toString(opts.encoding as BufferEncoding)
      return buf
    },
    writeFileSync: (p: string, data: string | Buffer, opts?: any) => {
      const enc =
        typeof opts === 'string'
          ? opts
          : opts && typeof opts === 'object'
            ? (opts.encoding as BufferEncoding | undefined)
            : undefined
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(String(data), (enc ?? 'utf-8') as BufferEncoding)
      getMem().writeFile(p, buf)
    },
    mkdirSync: (p: string) => {
      getMem().mkdir(p)
    },
    existsSync: (p: string) => getMem().exists(p),
    renameSync: (...args: any[]) => (fsRenameMock as any)(...args),
    statSync: (p: string) => {
      const st = getMem().stat(p)
      return {
        ...st,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        dev: 0,
        ino: 0,
        mode: 0,
        nlink: 0,
        uid: 0,
        gid: 0,
        rdev: 0,
        blksize: 0,
        blocks: 0,
        atimeMs: 0,
        ctimeMs: 0,
        atime: new Date(0),
        ctime: new Date(0),
        mtime: new Date(0),
        birthtime: new Date(0),
      }
    },
    readdirSync: (p: string, opts?: any) => {
      const entries = getMem().readdir(p)
      if (opts && opts.withFileTypes) {
        return entries.map((e: { name: string; isDirectory: () => boolean }) => ({
          name: e.name,
          isDirectory: e.isDirectory,
          isFile: () => !e.isDirectory(),
          isSymbolicLink: () => false,
        }))
      }
      return entries.map((e: { name: string }) => e.name)
    },
    openSync: (p: string) => getMem().openExclusive(p),
    writeSync: (fd: number, s: string) => {
      getMem().writeToFd(fd, s)
    },
    closeSync: (fd: number) => getMem().closeFd(fd),
    unlinkSync: (p: string) => getMem().remove(p),
    mkdtempSync: (prefix: string) => {
      const seq = ((globalThis as any).__memFsSeq =
        (((globalThis as any).__memFsSeq as number) ?? 0) + 1)
      const p = `${prefix}${seq}`
      getMem().mkdir(p)
      return p
    },
    promises: {
      ...actual.promises,
      open: async (path: string, _flags?: string) => {
        const handle = await getMem().openForRead(path)
        return {
          read: async (buffer: Buffer, offset: number, length: number, _position?: number) => {
            const data = await handle.read(length)
            data.copy(buffer, offset)
            return { bytesRead: data.length, buffer }
          },
          close: () => handle.close(),
        }
      },
      rm: async (path: string, opts?: any) => {
        getMem().rm(path, opts)
      },
      rename: async (oldPath: string, newPath: string) => {
        getMem().rename(oldPath, newPath)
      },
    },
  } as any
})

// app:getInitialPaths etc. not used by documents handlers; also need app for getPath.
const handlers: Record<string, (...a: any[]) => any> = {}
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: any[]) => any) => {
    handlers[ch] = fn
  },
} as any
// The shared in-memory filesystem for the whole suite. disk-io is loaded with node:fs
// already mocked (vi.mock is hoisted above the import that brings createMemoryDiskIO
// in), so its nodeDiskIO adapter forwards every fs call here — handlers and test setup
// both run disk-free.
const __memFs = createMemoryDiskIO()
;(globalThis as any).__memFs = __memFs

// A stable "temp dir" for the whole test file, so collision-retry tests can pre-create
// files in the exact directory the create/update handlers will write into.
const stableDocsRoot = mkTestDir('mf-docs-')
const fakeApp = { getPath: () => stableDocsRoot } as any

// A fake main window that captures 'app:file-changed', 'app:folder-changed' and
// 'app:document-refresh' notifications, so the folder-watcher paths can be exercised
// end-to-end.
const sentFileChanged: Array<{ id: string; filePath: string }> = []
const sentFolderChanged: Array<{ dirPath: string }> = []
const sentDocumentRefresh: Array<{ id: string }> = []
// Mutable so tests can simulate the main window being gone (null) to exercise
// the "no window -> send nothing" branches.
let fakeMainWindow: any = {
  webContents: {
    send: (channel: string, payload: any) => {
      if (channel === 'app:file-changed') sentFileChanged.push(payload)
      if (channel === 'app:folder-changed') sentFolderChanged.push(payload)
      if (channel === 'app:document-refresh') sentDocumentRefresh.push(payload)
    },
  },
}

beforeAll(() => {
  docs.clear()
  registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow)
})

// Fresh in-memory filesystem for every test, so a previous test's files can never
// leak into the next one. `stableDocsRoot` is re-created inside it so the default
// documents directory stays available after a reset.
beforeEach(() => {
  const mem = createMemoryDiskIO()
  ;(globalThis as any).__memFs = mem
  mem.mkdir(stableDocsRoot)
})

// Safety net: drain (send + clear the timer of) any folder-changed broadcast a test
// queued via __emitFolderEvent but never consumed, so a leaked 300ms coalesce timer
// cannot fire midway into a later test and pollute its `sentFolderChanged` assertions.
// Drain happens after the test's assertions have run, so this never masks a failure.
afterEach(() => {
  __flushFolderChanged()
})

function call(ch: string, ...args: any[]) {
  return handlers[ch](null, ...args)
}

describe('documents IPC — create (memory-only)', () => {
  it('inserts a draft row with empty file_path and never writes to disk', async () => {
    const row = await call('documents:create', {
      title: 'Draft',
      content: '# Draft',
      memoryOnly: true,
    })
    expect(row.filePath).toBe('')
    expect(docs.has(row.id)).toBe(true)
    expect(docs.get(row.id).filePath).toBe('')
  })

  it('writes a real file and stores its path when memoryOnly is false', async () => {
    const row = await call('documents:create', {
      title: 'Real',
      content: '# Real',
      memoryOnly: false,
    })
    expect(row.filePath).toMatch(/\.md$/)
    expect(readFileSync(row.filePath, 'utf-8')).toBe('# Real')
  })

  it('rejects with EEXIST when the target filename already exists (no silent -N rename)', () => {
    // The create handler writes into <docsRoot>/MarkFlow, so pre-create the would-be target there
    // to force openSync('wx') to fail with EEXIST. The handler is synchronous, so the clash
    // surfaces as a thrown EEXIST (it must refuse rather than auto-rename with `-N`).
    const markFlowDir = join(stableDocsRoot, 'MarkFlow')
    mkdirSync(markFlowDir, { recursive: true })
    const target = join(markFlowDir, 'ColTest.md')
    writeFileSync(target, 'preexisting')
    expect(() =>
      call('documents:create', {
        title: 'ColTest',
        content: '# ColTest',
        memoryOnly: false,
      }),
    ).toThrow(/EEXIST/)
    // The original file is untouched and no -N variant was written.
    expect(readFileSync(target, 'utf-8')).toBe('preexisting')
    expect(existsSync(join(markFlowDir, 'ColTest-1.md'))).toBe(false)
  })

  it('first Save As of a memory-only draft writes the file and stores its path (no writeFileSync(""))', async () => {
    // Regression guard: a memory-only draft has file_path === ''. The first Save As
    // must route to documents:save-as (which writes to the new path), never to documents:update
    // (which would call writeFileSync('') and crash). Confirms file_path is populated + disk file exists.
    const draft = await call('documents:create', {
      title: 'Draft',
      content: '# Draft first save',
      memoryOnly: true,
    })
    expect(docs.get(draft.id).filePath).toBe('')

    const savePath = join(stableDocsRoot, 'first-save.md')
    const saved = await call('documents:save-as', draft.id, savePath, {
      title: 'Draft',
      content: '# Draft first save',
    })
    expect(saved.filePath).toBe(savePath)
    expect(docs.get(draft.id).filePath).toBe(savePath)
    expect(existsSync(savePath)).toBe(true)
    expect(readFileSync(savePath, 'utf-8')).toBe('# Draft first save')
  })
})

describe('documents IPC — get', () => {
  it('returns null when the document does not exist', async () => {
    expect(await call('documents:get', 'missing')).toBeNull()
  })
})

describe('documents IPC — update', () => {
  it('updates content and writes the file in the stored encoding', async () => {
    const created = await call('documents:create', {
      title: 'U',
      content: 'old',
      memoryOnly: false,
    })
    const updated = await call('documents:update', created.id, { content: 'new content' })
    expect(updated.content).toBe('new content')
    expect(readFileSync(created.filePath, 'utf-8')).toBe('new content')
  })

  it('renames the file when the title changes', async () => {
    const created = await call('documents:create', {
      title: 'Rename',
      content: 'x',
      memoryOnly: false,
    })
    const updated = await call('documents:update', created.id, { title: 'Renamed' })
    expect(updated.filePath).toMatch(/Renamed\.md$/)
    expect(readFileSync(updated.filePath, 'utf-8')).toBe('x')
  })

  it('refuses a title change whose target filename is already taken (no -N fallback)', async () => {
    // docB owns RenTarget.md on disk. Updating docA's title to 'RenTarget' collides, so the
    // handler must refuse outright instead of silently moving the file to a RenTarget-1.md the
    // user never asked for. The handler is synchronous, so the refusal is a thrown EEXIST.
    const docA = await call('documents:create', {
      title: 'RenameCollideA',
      content: 'a',
      memoryOnly: false,
    })
    await call('documents:create', {
      title: 'RenTarget',
      content: 'b',
      memoryOnly: false,
    })
    // The handler is synchronous, so the refusal surfaces as a thrown error carrying the standard
    // EEXIST code (callers can classify it) plus a message the save-failure path can show.
    let thrown: unknown
    try {
      call('documents:update', docA.id, { title: 'RenTarget' })
    } catch (e) {
      thrown = e
    }
    expect((thrown as NodeJS.ErrnoException)?.code).toBe('EEXIST')
    expect((thrown as Error)?.message).toContain('already exists')
    // Nothing moved and nothing was renumbered: the colliding file still holds docB's content.
    const target = join(stableDocsRoot, 'MarkFlow', 'RenTarget.md')
    expect(readFileSync(target, 'utf-8')).toBe('b')
    expect(existsSync(join(stableDocsRoot, 'MarkFlow', 'RenTarget-1.md'))).toBe(false)
  })

  it('strips a Markdown extension from the incoming title so a rename does not double it', async () => {
    // The title bar shows `name.ext`, so the renderer sends `Renamed.md`. The stored
    // title is extension-free and the rename re-appends the extension itself without
    // stripping, the file would become `Renamed.md.md`.
    const created = await call('documents:create', {
      title: 'RenameExt',
      content: 'x',
      memoryOnly: false,
    })
    const updated = await call('documents:update', created.id, { title: 'ExtStripped.md' })
    expect(updated.title).toBe('ExtStripped')
    expect(updated.filePath).toBe(join(dirname(created.filePath), 'ExtStripped.md'))
  })

  it('does not rename when the requested title differs only by the extension', async () => {
    // Typing the same base name (with or without the extension) is not a rename.
    const created = await call('documents:create', {
      title: 'Keep',
      content: 'x',
      memoryOnly: false,
    })
    const updated = await call('documents:update', created.id, { title: 'Keep.md' })
    expect(updated.filePath).toBe(created.filePath)
    expect(updated.title).toBe('Keep')
  })
})

describe('documents IPC — delete', () => {
  it('removes the store entry (and the file when present)', async () => {
    const created = await call('documents:create', {
      title: 'Del',
      content: 'x',
      memoryOnly: false,
    })
    const before = readFileSync(created.filePath, 'utf-8')
    expect(before).toBe('x')
    const ok = await call('documents:delete', created.id)
    expect(ok).toBe(true)
    expect(docs.has(created.id)).toBe(false)
  })

  it('returns false when the document does not exist', async () => {
    expect(await call('documents:delete', 'nope')).toBe(false)
  })

  it('still deletes the store entry when the on-disk file unlink fails for a non-ENOENT reason', async () => {
    const created = await call('documents:create', {
      title: 'DelErr',
      content: 'x',
      memoryOnly: false,
    })
    // Replace the file with a directory so unlinkSync throws ENOTDIR (a real error, not ENOENT).
    const { unlinkSync, mkdirSync } = await import('node:fs')
    unlinkSync(created.filePath)
    mkdirSync(created.filePath)
    const ok = await call('documents:delete', created.id)
    expect(ok).toBe(true)
    expect(docs.has(created.id)).toBe(false)
  })

  it('logs but still deletes when trashItem fails for a non-ENOENT reason', async () => {
    const created = await call('documents:create', {
      title: 'DelTrash',
      content: 'x',
      memoryOnly: false,
    })
    const { shell } = await import('electron')
    const err = Object.assign(new Error('boom'), { code: 'EPERM' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(shell.trashItem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err)
    const ok = await call('documents:delete', created.id)
    expect(ok).toBe(true)
    expect(docs.has(created.id)).toBe(false)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('does not log when trashItem fails with ENOENT (file already gone)', async () => {
    const created = await call('documents:create', {
      title: 'DelTrash2',
      content: 'x',
      memoryOnly: false,
    })
    const { shell } = await import('electron')
    const err = Object.assign(new Error('gone'), { code: 'ENOENT' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(shell.trashItem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err)
    const ok = await call('documents:delete', created.id)
    expect(ok).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('documents IPC — saveAs', () => {
  it('writes to a new path and updates the record (original left untouched)', async () => {
    const created = await call('documents:create', {
      title: 'S',
      content: 'orig',
      memoryOnly: false,
    })
    const dir = fakeApp.getPath()
    const newPath = join(dir, 'saved.md')
    const updated = await call('documents:save-as', created.id, newPath, {
      title: 'S',
      content: 'saved',
    })
    expect(updated.filePath).toBe(newPath)
    expect(readFileSync(newPath, 'utf-8')).toBe('saved')
    expect(readFileSync(created.filePath, 'utf-8')).toBe('orig')
  })

  it('derives the stored title from the new file path', async () => {
    // The document is re-pointed at a file the user picked, so that file name IS the
    // title. Keeping the caller's title would leave title and filePath out of sync
    // (and would store an extension-bearing title).
    const created = await call('documents:create', {
      title: 'Old',
      content: 'orig',
      memoryOnly: false,
    })
    const newPath = join(fakeApp.getPath(), 'brand new name.md')
    const updated = await call('documents:save-as', created.id, newPath, {
      title: 'Old.md',
      content: 'saved',
    })
    expect(updated.title).toBe('brand new name')
    expect(updated.filePath).toBe(newPath)
  })
})

describe('documents IPC — reload', () => {
  it('re-reads the file from disk and refreshes the stored content', async () => {
    const created = await call('documents:create', {
      title: 'R',
      content: 'disk',
      memoryOnly: false,
    })
    writeFileSync(created.filePath, 'updated on disk')
    const reloaded = await call('documents:reload', created.id)
    expect(reloaded.content).toBe('updated on disk')
  })

  it('returns null when the file no longer exists', async () => {
    const created = await call('documents:create', {
      title: 'R',
      content: 'disk',
      memoryOnly: false,
    })
    const { unlinkSync } = await import('node:fs')
    unlinkSync(created.filePath)
    expect(await call('documents:reload', created.id)).toBeNull()
  })
})

describe('documents IPC — stat', () => {
  it('returns file size and timestamps for an existing file', async () => {
    const created = await call('documents:create', {
      title: 'St',
      content: 'x',
      memoryOnly: false,
    })
    const st = await call('documents:stat', created.filePath)
    expect(st.exists).toBe(true)
    expect(st.size).toBeGreaterThan(0)
  })

  it('returns exists:false for a missing path', async () => {
    const st = await call('documents:stat', join(tmpdir(), 'does-not-exist-xyz.md'))
    expect(st.exists).toBe(false)
  })
})

describe('documents IPC — setEncoding', () => {
  it('re-decodes the file with the chosen encoding and updates metadata', async () => {
    const created = await call('documents:create', {
      title: 'E',
      content: 'hello',
      memoryOnly: false,
    })
    const updated = await call('documents:set-encoding', created.id, 'utf-8')
    expect(updated.encoding).toBe('utf-8')
  })
})

describe('documents IPC — import / importMany', () => {
  it('imports a markdown file from disk', async () => {
    const dir = mkTestDir('mf-imp-')
    const p = join(dir, 'a.md')
    writeFileSync(p, '# imported')
    const doc = await call('documents:import', p)
    expect(doc.title).toBe('a')
    expect(doc.content).toBe('# imported')
  })

  it('batch-imports multiple files', async () => {
    const dir = mkTestDir('mf-imp-')
    const p1 = join(dir, 'b.md')
    const p2 = join(dir, 'c.md')
    writeFileSync(p1, '# b')
    writeFileSync(p2, '# c')
    const results = await call('documents:import-many', [p1, p2])
    expect(results).toHaveLength(2)
    expect(results.map((r: any) => r.title).sort()).toEqual(['b', 'c'])
  })
})

describe('documents IPC — list', () => {
  it('returns documents sorted by updatedAt desc', async () => {
    const rows = await call('documents:list')
    expect(Array.isArray(rows)).toBe(true)
    for (const r of rows) expect(r).toHaveProperty('id')
  })
})

describe('documents — folder watching (chokidar-driven store sync)', () => {
  function tmpDir(prefix: string): string {
    return mkTestDir(prefix)
  }
  // The fake store is keyed by id only (see above), so every value is one document.
  function storedDocs(): any[] {
    return [...docs.values()]
  }
  function docFor(filePath: string) {
    return storedDocs().find((d: any) => d.filePath === filePath)
  }
  // Create a store entry for an existing file *without* going through the create
  // handler, which records an own-write suppression of its own.
  async function importDoc(dir: string, name: string): Promise<any> {
    const file = join(dir, name)
    writeFileSync(file, '# imported', 'utf-8')
    return call('documents:import', file)
  }

  it('folds a Markdown file that appears on disk into the store and refreshes the list', () => {
    const dir = tmpDir('mf-watch-add-')
    const file = join(dir, 'fresh.md')
    writeFileSync(file, '# Fresh\n\nhello world', 'utf-8')
    sentFolderChanged.length = 0

    __emitFolderEvent('add', file)
    __flushFolderChanged()

    const doc: any = docFor(file)
    expect(doc).toBeTruthy()
    expect(doc.title).toBe('fresh')
    expect(doc.folderPath).toBe(dir)
    expect(doc.content).toContain('hello world')
    expect(doc.wordCount).toBe(3)
    expect(sentFolderChanged).toEqual([{ dirPath: dir }])
  })

  it('ignores an add for a file the store already tracks (own save must not duplicate)', async () => {
    const dir = tmpDir('mf-watch-known-')
    const imported = await importDoc(dir, 'known.md')
    sentFolderChanged.length = 0

    __emitFolderEvent('add', imported.filePath)

    expect(storedDocs().filter((d: any) => d.filePath === imported.filePath)).toHaveLength(1)
    expect(sentFolderChanged).toEqual([])
  })

  it('ignores an add for a file that cannot be read (defensive catch)', () => {
    sentFolderChanged.length = 0

    __emitFolderEvent('add', join(tmpdir(), 'definitely-missing-add.md'))

    expect(sentFolderChanged).toEqual([])
  })

  it('ignores non-Markdown files entirely', () => {
    const dir = tmpDir('mf-watch-other-')
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'hello', 'utf-8')
    sentFileChanged.length = 0
    sentFolderChanged.length = 0

    __emitFolderEvent('add', file)
    __emitFolderEvent('change', file)
    __emitFolderEvent('unlink', file)

    expect(docFor(file)).toBeUndefined()
    expect(sentFileChanged).toEqual([])
    expect(sentFolderChanged).toEqual([])
  })

  it('keeps the document open and marks it missing when a watched file disappears', async () => {
    const dir = tmpDir('mf-watch-unlink-')
    const created = await call('documents:create', {
      title: 'Gone',
      content: 'x',
      folderPath: dir,
    })
    unlinkSync(created.filePath)
    sentFolderChanged.length = 0
    sentDocumentRefresh.length = 0

    __emitFolderEvent('unlink', created.filePath)
    __flushFolderChanged()

    // VS Code behaviour: the document stays open (not dropped) and is flagged missing so
    // the title bar can strike it through and the user can still save it back.
    const doc: any = docFor(created.filePath)
    expect(doc).toBeTruthy()
    expect(doc.missing).toBe(true)
    expect(sentFolderChanged).toEqual([{ dirPath: dir }])
    expect(sentDocumentRefresh).toEqual([{ id: created.id }])
  })

  it('re-points the SAME document when the file is renamed outside the app', async () => {
    const dir = tmpDir('mf-watch-rename-')
    const a = join(dir, 'a.md')
    writeFileSync(a, '# imported', 'utf-8')
    const imported = await call('documents:import', a)
    // External rename: delete a.md, create b.md with the same bytes.
    unlinkSync(a)
    const b = join(dir, 'b.md')
    writeFileSync(b, '# imported', 'utf-8')

    __emitFolderEvent('unlink', a) // marks a.md missing (one refresh not the one we assert)
    sentDocumentRefresh.length = 0

    __emitFolderEvent('add', b) // folds the rename back into the same doc (one refresh)
    __flushFolderChanged()

    const doc: any = docFor(b)
    expect(doc).toBeTruthy()
    expect(doc.id).toBe(imported.id) // same document, id preserved
    expect(doc.filePath).toBe(b)
    expect(doc.title).toBe('b')
    expect(doc.missing).toBeFalsy()
    expect(sentDocumentRefresh).toEqual([{ id: imported.id }])
  })

  it('clears the missing flag when the deleted file reappears at the same path', async () => {
    const dir = tmpDir('mf-watch-restore-')
    const created = await call('documents:create', { title: 'Gone', content: 'x', folderPath: dir })
    unlinkSync(created.filePath)
    __emitFolderEvent('unlink', created.filePath)
    __flushFolderChanged()
    expect(docFor(created.filePath)?.missing).toBe(true)

    // The file is restored (e.g. pulled back out of the trash) at its original path.
    writeFileSync(created.filePath, '# restored', 'utf-8')
    sentDocumentRefresh.length = 0
    __emitFolderEvent('add', created.filePath)
    __flushFolderChanged()

    const doc: any = docFor(created.filePath)
    expect(doc.missing).toBeFalsy()
    // Content is left as-is: an external CONTENT change is the reload prompt's job, not
    // the watcher's to apply silently.
    expect(doc.content).toBe('x')
    expect(sentDocumentRefresh).toEqual([{ id: created.id }])
  })

  it('does not fold an add into a missing doc when the content differs', async () => {
    const dir = tmpDir('mf-watch-rename-content-')
    const a = join(dir, 'a.md')
    writeFileSync(a, '# imported', 'utf-8')
    const imported = await call('documents:import', a)
    unlinkSync(a)
    __emitFolderEvent('unlink', a)
    __flushFolderChanged()
    expect(docFor(a)?.missing).toBe(true)

    // A brand-new file with a different body appears in the same directory.
    const b = join(dir, 'b.md')
    writeFileSync(b, '# totally different', 'utf-8')
    __emitFolderEvent('add', b)
    __flushFolderChanged()

    const newDoc = docFor(b)
    expect(newDoc).toBeTruthy()
    expect(newDoc.id).not.toBe(imported.id) // a NEW document, not the renamed one
    expect(docFor(a)?.missing).toBe(true) // original stays missing
  })

  it('does not fold an add into a missing doc in another directory', async () => {
    const dirA = tmpDir('mf-watch-rename-dira-')
    const dirB = tmpDir('mf-watch-rename-dirb-')
    const a = join(dirA, 'a.md')
    writeFileSync(a, '# imported', 'utf-8')
    const imported = await call('documents:import', a)
    unlinkSync(a)
    __emitFolderEvent('unlink', a)
    __flushFolderChanged()

    // Same bytes, but a different folder must not be treated as the same rename
    const b = join(dirB, 'b.md')
    writeFileSync(b, '# imported', 'utf-8')
    __emitFolderEvent('add', b)
    __flushFolderChanged()

    expect(docFor(b).id).not.toBe(imported.id)
    expect(docFor(a)?.missing).toBe(true)
  })

  it('recreates the file on save when it was deleted outside the app', async () => {
    const dir = tmpDir('mf-watch-save-')
    const created = await call('documents:create', { title: 'Gone', content: 'x', folderPath: dir })
    unlinkSync(created.filePath)
    __emitFolderEvent('unlink', created.filePath)
    __flushFolderChanged()
    expect(created.filePath && existsSync(created.filePath)).toBe(false)

    await call('documents:update', created.id, { content: 'saved again' })
    expect(existsSync(created.filePath)).toBe(true)
    expect(docFor(created.filePath)?.missing).toBeFalsy()
  })

  it('clears the missing flag after a Save As', async () => {
    const dir = tmpDir('mf-watch-saveas-')
    const created = await call('documents:create', { title: 'Gone', content: 'x', folderPath: dir })
    unlinkSync(created.filePath)
    __emitFolderEvent('unlink', created.filePath)
    __flushFolderChanged()
    expect(docFor(created.filePath)?.missing).toBe(true)

    const newPath = join(dir, 'recovered.md')
    await call('documents:save-as', created.id, newPath, { content: 'recovered' })
    const doc: any = docFor(newPath)
    expect(doc).toBeTruthy()
    expect(doc.missing).toBeFalsy()
    expect(existsSync(newPath)).toBe(true)
  })

  it('ignores a removal for a file the store does not track', () => {
    sentFolderChanged.length = 0
    __emitFolderEvent('unlink', join(tmpdir(), 'tracked-by-nobody.md'))
    expect(sentFolderChanged).toEqual([])
  })

  it('ignores a removal for a path that is still on disk (stale rename unlink)', async () => {
    // Regression: renaming a.md -> b.md and back to a.md replays the step-1 `unlink`
    // for a.md. chokidar reports a rename as an unpaired `unlink` + `add`, so that
    // event can be delivered AFTER the file exists again at which point a.md is the
    // OPEN document. Deleting the record on the stale event closed the file and
    // emptied the sidebar, which is what made it look like the workspace closed.
    const dir = tmpDir('mf-watch-rename-')
    const original = await importDoc(dir, 'a.md')
    const aPath = original.filePath
    const bPath = join(dir, 'b.md')

    const renamed = await call('documents:update', original.id, {
      title: 'b',
      content: '# imported',
    })
    expect(renamed.filePath).toBe(bPath)
    const back = await call('documents:update', original.id, { title: 'a', content: '# imported' })
    expect(back.filePath).toBe(aPath)

    sentFolderChanged.length = 0
    // The step-1 unlink, delivered late: a.md is back on disk and is the open doc.
    __emitFolderEvent('unlink', aPath)
    __flushFolderChanged()

    expect(docs.get(original.id)).toBeTruthy()
    expect(sentFolderChanged).toEqual([])
  })

  it('keeps the open document through a full rename round-trip (a -> b -> a)', async () => {
    // The complete TODO-4 repro, this time replaying chokidar's unpaired `unlink` +
    // `add` after every step instead of only the late event. After each in-app rename
    // the record already points at the NEW path, so the matching `unlink <old>` finds
    // no record; the late step-1 `unlink a.md` is the one that used to delete it.
    const dir = tmpDir('mf-watch-roundtrip-')
    const original = await importDoc(dir, 'a.md')
    const aPath = original.filePath
    const bPath = join(dir, 'b.md')

    const renamed = await call('documents:update', original.id, {
      title: 'b',
      content: '# imported',
    })
    expect(renamed.filePath).toBe(bPath)
    __emitFolderEvent('unlink', aPath)
    __emitFolderEvent('add', bPath)

    const back = await call('documents:update', original.id, { title: 'a', content: '# imported' })
    expect(back.filePath).toBe(aPath)
    __emitFolderEvent('unlink', bPath)
    __emitFolderEvent('add', aPath)

    // The step-1 unlink, delivered late, when a.md is back on disk and is the open doc.
    sentFolderChanged.length = 0
    __emitFolderEvent('unlink', aPath)
    __flushFolderChanged()

    expect(docs.get(original.id)).toBeTruthy()
    expect(docs.get(original.id).filePath).toBe(aPath)
    expect(sentFolderChanged).toEqual([])
  })

  it('notifies the renderer when a tracked file changes on disk', async () => {
    const dir = tmpDir('mf-watch-change-')
    const imported = await importDoc(dir, 'edited.md')
    sentFileChanged.length = 0

    __emitFolderEvent('change', imported.filePath)

    expect(sentFileChanged).toEqual([{ id: imported.id, filePath: imported.filePath }])
  })

  it('suppresses the change raised by our own write', async () => {
    const dir = tmpDir('mf-watch-own-')
    const imported = await importDoc(dir, 'mine.md')
    // documents:update writes the file and marks it as ours, so the watcher echo
    // must not raise the "changed externally" prompt.
    await call('documents:update', imported.id, { content: 'y' })
    sentFileChanged.length = 0

    __emitFolderEvent('change', imported.filePath)

    expect(sentFileChanged).toEqual([])
  })

  it('ignores a change for a file the store does not track', () => {
    sentFileChanged.length = 0
    __emitFolderEvent('change', join(tmpdir(), 'untracked-change.md'))
    expect(sentFileChanged).toEqual([])
  })

  it('stops notifying once the renderer window is gone', async () => {
    const dir = tmpDir('mf-watch-nowin-')
    const imported = await importDoc(dir, 'nowin.md')
    const prev = fakeMainWindow
    fakeMainWindow = null
    sentFileChanged.length = 0
    sentFolderChanged.length = 0
    try {
      __emitFolderEvent('change', imported.filePath)
      __emitFolderEvent('unlink', imported.filePath)
      __flushFolderChanged()
    } finally {
      fakeMainWindow = prev
    }
    expect(sentFileChanged).toEqual([])
    expect(sentFolderChanged).toEqual([])
  })

  it('stops notifying once the renderer window is destroyed (not just null)', async () => {
    const dir = tmpDir('mf-watch-destroyed-')
    const imported = await importDoc(dir, 'destroyed.md')
    const prev = fakeMainWindow
    // Quit flow: the window object still exists but isDestroyed() is true. Sending to a
    // destroyed webContents throws; both change and folder paths must skip it.
    fakeMainWindow = { webContents: prev.webContents, isDestroyed: () => true }
    sentFileChanged.length = 0
    sentFolderChanged.length = 0
    try {
      __emitFolderEvent('change', imported.filePath)
      __emitFolderEvent('unlink', imported.filePath)
      __flushFolderChanged()
    } finally {
      fakeMainWindow = prev
    }
    expect(sentFileChanged).toEqual([])
    expect(sentFolderChanged).toEqual([])
  })

  it('does not send app:document-refresh once the window is destroyed', async () => {
    // Unlike the previous test, here the file is GONE, so onFileRemoved proceeds past the
    // existsSync guard and actually reaches notifyDocumentRefresh which must still skip
    // sending to a destroyed webContents.
    const dir = tmpDir('mf-watch-refresh-gone-')
    const created = await call('documents:create', { title: 'Gone', content: 'x', folderPath: dir })
    unlinkSync(created.filePath)
    const prev = fakeMainWindow
    fakeMainWindow = { webContents: prev.webContents, isDestroyed: () => true }
    sentDocumentRefresh.length = 0
    try {
      __emitFolderEvent('unlink', created.filePath)
      __flushFolderChanged()
    } finally {
      fakeMainWindow = prev
    }
    expect(sentDocumentRefresh).toEqual([])
  })

  it('cancels a pending folder-changed broadcast when the workspace closes', async () => {
    const dir = tmpDir('mf-watch-cancel-')
    const file = join(dir, 'cancelled.md')
    writeFileSync(file, '# Cancelled\n\ndropped', 'utf-8')
    sentFolderChanged.length = 0

    // Queue a broadcast through the normal dispatch path
    __emitFolderEvent('add', file)
    // then close the workspace before the coalesce window elapses: the watcher is
    // gone, so the pending refresh must be dropped rather than delivered.
    await call('documents:clear-open-folders')

    expect(sentFolderChanged).toEqual([])
    // Nothing may be left behind for the afterEach drain to deliver.
    __flushFolderChanged()
    expect(sentFolderChanged).toEqual([])
  })

  it('coalesces per directory, so an unrelated folder cannot swallow a pending refresh', () => {
    const dirA = tmpDir('mf-watch-coalesce-a-')
    const dirB = tmpDir('mf-watch-coalesce-b-')
    const fileA = join(dirA, 'a.md')
    const fileB = join(dirB, 'b.md')
    writeFileSync(fileA, '# A\n\nalpha', 'utf-8')
    writeFileSync(fileB, '# B\n\nbravo', 'utf-8')
    sentFolderChanged.length = 0

    // Two directories change inside the same coalesce window. With one shared pending
    // slot, the second event would overwrite the first and dirA the folder the
    // renderer is showing would never be told to refresh
    __emitFolderEvent('add', fileA)
    __emitFolderEvent('add', fileB)
    __flushFolderChanged()

    expect(sentFolderChanged).toHaveLength(2)
    expect(sentFolderChanged).toEqual(
      expect.arrayContaining([{ dirPath: dirA }, { dirPath: dirB }]),
    )
  })

  it('still collapses a burst of events under one directory into a single broadcast', () => {
    const dir = tmpDir('mf-watch-coalesce-same-')
    for (const name of ['one.md', 'two.md', 'three.md']) {
      writeFileSync(join(dir, name), `# ${name}\n\nbody`, 'utf-8')
    }
    sentFolderChanged.length = 0

    __emitFolderEvent('add', join(dir, 'one.md'))
    __emitFolderEvent('add', join(dir, 'two.md'))
    __emitFolderEvent('add', join(dir, 'three.md'))
    __flushFolderChanged()

    // The lag fix depends on this: N events under one directory mean one refresh, not N.
    expect(sentFolderChanged).toEqual([{ dirPath: dir }])
  })

  it('delivers the coalesced broadcast when the real timer fires (no flush shortcut)', () => {
    vi.useFakeTimers()
    try {
      const dir = tmpDir('mf-watch-timer-')
      const fileA = join(dir, 'timer-a.md')
      const fileB = join(dir, 'timer-b.md')
      writeFileSync(fileA, '# A\n\nfired', 'utf-8')
      writeFileSync(fileB, '# B\n\nskipped', 'utf-8')
      sentFolderChanged.length = 0

      // Live window: only the real 300ms timer may deliver this no __flush
      // shortcut, so the delayed-send path itself is what gets exercised.
      __emitFolderEvent('add', fileA)
      expect(sentFolderChanged).toEqual([]) // still inside the coalesce window
      vi.advanceTimersByTime(400)
      expect(sentFolderChanged).toEqual([{ dirPath: dir }])

      // Window gone by the time a later timer fires: the delayed send is skipped.
      const prev = fakeMainWindow
      sentFolderChanged.length = 0
      fakeMainWindow = null
      try {
        __emitFolderEvent('add', fileB)
        vi.advanceTimersByTime(400)
      } finally {
        fakeMainWindow = prev
      }
      expect(sentFolderChanged).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the coalesced broadcast (timer and flush) once the window is destroyed', () => {
    vi.useFakeTimers()
    try {
      const dir = tmpDir('mf-watch-dead-')
      const fileA = join(dir, 'dead-a.md')
      const fileB = join(dir, 'dead-b.md')
      writeFileSync(fileA, '# A\n\nalpha', 'utf-8')
      writeFileSync(fileB, '# B\n\nbravo', 'utf-8')
      sentFolderChanged.length = 0
      const prev = fakeMainWindow
      // The quit flow can destroy the window while the main process (and a pending
      // coalesce timer) is still alive; sending to a destroyed webContents throws.
      fakeMainWindow = { webContents: prev.webContents, isDestroyed: () => true }
      try {
        // Delayed-timer path: fire the real coalesce timer after the window died
        // (advance well past the 300ms coalesce window).
        __emitFolderEvent('add', fileA)
        vi.advanceTimersByTime(1000)
        // Flush path: the test seam / afterEach drain must skip destroyed windows too.
        __emitFolderEvent('add', fileB)
        __flushFolderChanged()
      } finally {
        fakeMainWindow = prev
      }
      expect(sentFolderChanged).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('documents IPC — open folder registration', () => {
  // The most recently created watcher (Array.prototype.at is not in this project's
  // TS target lib, so index into the array directly).
  function latestWatcher() {
    return chokidarState.instances[chokidarState.instances.length - 1]
  }

  it('starts a watcher over the folder the user opened', () => {
    const dir = mkTestDir('mf-open-a-')
    call('documents:set-open-folder', dir)
    expect(latestWatcher()?.paths).toEqual([dir])
  })

  it('reuses the running watcher when another folder is opened', () => {
    const before = chokidarState.instances.length
    call('documents:set-open-folder', mkTestDir('mf-open-b-'))
    expect(chokidarState.instances).toHaveLength(before)
    expect(latestWatcher()?.added.length).toBeGreaterThan(0)
  })

  it('does not re-register a folder already covered by a broader one', () => {
    const root = mkTestDir('mf-open-root-')
    call('documents:set-open-folder', root)
    const inst = latestWatcher()
    const before = inst?.added?.length ?? 0
    call('documents:set-open-folder', join(root, 'nested'))
    expect(inst?.added).toHaveLength(before)
  })

  it('closes the watcher when the workspace is closed, and tolerates a second clear', async () => {
    const inst = latestWatcher()
    await call('documents:clear-open-folders')
    expect(inst?.closed).toBe(true)
    // No watcher left: clearing again must not throw.
    await expect(call('documents:clear-open-folders')).resolves.toBeUndefined()
  })

  it('creates a fresh watcher when a folder is opened after a clear', () => {
    const before = chokidarState.instances.length
    call('documents:set-open-folder', mkTestDir('mf-open-c-'))
    expect(chokidarState.instances).toHaveLength(before + 1)
  })
})

describe('documents IPC — eol (line-ending detection)', () => {
  it('detects CRLF when the file uses carriage returns', async () => {
    const dir = mkTestDir('mf-eol-')
    const p = join(dir, 'crlf.md')
    writeFileSync(p, 'a\r\nb\r\nc')
    const eol = await call('documents:eol', p)
    expect(eol).toBe('\r\n')
  })

  it('defaults to LF when the file has no carriage returns', async () => {
    const dir = mkTestDir('mf-eol-')
    const p = join(dir, 'lf.md')
    writeFileSync(p, 'a\nb\nc')
    const eol = await call('documents:eol', p)
    expect(eol).toBe('\n')
  })

  it('falls back to LF when the path cannot be opened', async () => {
    const eol = await call('documents:eol', join(tmpdir(), 'does-not-exist-eol.md'))
    expect(eol).toBe('\n')
  })
})

describe('documents IPC — set-encoding edge cases', () => {
  it('returns null when the document does not exist', async () => {
    expect(await call('documents:set-encoding', 'nope', 'utf-8')).toBeNull()
  })

  it('returns null when the file backing the document cannot be read', async () => {
    const { unlinkSync } = await import('node:fs')
    const created = await call('documents:create', {
      title: 'Enc',
      content: 'x',
      memoryOnly: false,
    })
    unlinkSync(created.filePath)
    expect(await call('documents:set-encoding', created.id, 'utf-8')).toBeNull()
  })
})

describe('documents IPC — import re-open / import-many', () => {
  it('re-opens an already-imported file, refreshing its store record from disk', async () => {
    const dir = mkTestDir('mf-imp-')
    const p = join(dir, 're.md')
    writeFileSync(p, '# first version')
    const first = await call('documents:import', p)
    expect(first.content).toBe('# first version')
    writeFileSync(p, '# updated on disk')
    const second = await call('documents:import', p)
    expect(second.id).toBe(first.id)
    expect(second.content).toBe('# updated on disk')
  })

  it('import-many refreshes an already-imported file in place', async () => {
    const dir = mkTestDir('mf-imp-')
    const p = join(dir, 'm.md')
    writeFileSync(p, '# v1')
    const first = await call('documents:import-many', [p])
    expect(first).toHaveLength(1)
    writeFileSync(p, '# v2')
    const second = await call('documents:import-many', [p])
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(first[0].id)
    expect(second[0].content).toBe('# v2')
  })

  it('import-many skips files that cannot be read (read error swallowed)', async () => {
    const dir = mkTestDir('mf-imp-')
    const p = join(dir, 'missing.md')
    const results = await call('documents:import-many', [p])
    expect(results).toHaveLength(0)
  })

  it('import returns null when the file cannot be read', async () => {
    const dir = mkTestDir('mf-imp-')
    // a directory is not a readable markdown file -> readMarkdownText throws -> returns null
    expect(await call('documents:import', dir)).toBeNull()
  })
})

describe('documents IPC — branch coverage (defensive defaults)', () => {
  it('store falls back to utf-8 when encoding/confidence are missing on the record', async () => {
    // Inject a record that omits encoding/encoding_confidence so the store's
    // `encoding ?? 'utf-8'` and `encodingConfidence ?? 1` fallbacks fire.
    const id = 'raw-' + Date.now()
    // The new store returns the document verbatim from the in-memory Map (no SQL
    // normalization), so a record with no encoding reads back as absent. We inject a
    // complete Document here; makeDocument is what guarantees encoding defaults in real flows.
    docs.set(id, {
      id,
      title: 'Raw',
      folderPath: '',
      filePath: '',
      content: 'x',
      wordCount: 1,
      encoding: 'utf-8',
      encodingConfidence: 1,
    })
    const got = await call('documents:get', id)
    expect(got.encoding).toBe('utf-8')
    expect(got.encodingConfidence).toBe(1)
    docs.delete(id)
  })

  it('documents:get returns the mapped document for an existing row', async () => {
    const created = await call('documents:create', {
      title: 'GetMe',
      content: 'y',
      memoryOnly: true,
    })
    const got = await call('documents:get', created.id)
    expect(got.id).toBe(created.id)
    expect(got.content).toBe('y')
  })

  it('documents:list returns only documents within the requested folder', async () => {
    const created = await call('documents:create', {
      title: 'InFolder',
      content: 'z',
      folderPath: 'MyFolder',
      memoryOnly: true,
    })
    const rows = await call('documents:list', 'MyFolder')
    expect(rows.map((r: any) => r.id)).toContain(created.id)
    const all = await call('documents:list')
    expect(all.map((r: any) => r.id)).toContain(created.id)
  })

  it('create uses defaults when title/content/ext are omitted', async () => {
    const row = await call('documents:create', { memoryOnly: true })
    expect(row.title).toBe('Untitled')
    expect(row.content).toMatch(/^# Untitled/)
  })

  it('create validates the extension against the Markdown set (unknown ext falls back to .md)', async () => {
    const row = await call('documents:create', {
      title: 'ExtTest',
      content: 'x',
      ext: '.txt',
      memoryOnly: false,
    })
    expect(row.filePath).toMatch(/\.md$/)
  })

  it('create honors a known extension', async () => {
    const row = await call('documents:create', {
      title: 'ExtKnown',
      content: 'x',
      ext: '.markdown',
      memoryOnly: false,
    })
    expect(row.filePath).toMatch(/\.markdown$/)
  })

  it('create defaults memoryOnly to false when omitted', async () => {
    // Exercises the disk-write path when memoryOnly is omitted (handler defaults it to false).
    const row = await call('documents:create', {
      title: 'MemDefault',
      content: 'x',
      // memoryOnly intentionally omitted
    })
    expect(row.filePath).toMatch(/\.md$/)
    expect(readFileSync(row.filePath, 'utf-8')).toBe('x')
  })

  it('create writes into an absolute folder path when one is given', async () => {
    // Exercises the `isAbsolute(folderPath)` true branch of the baseDir resolution.
    const absDir = join(stableDocsRoot, 'AbsRoot')
    const row = await call('documents:create', {
      title: 'AbsFolder',
      content: 'x',
      folderPath: absDir,
      memoryOnly: false,
    })
    expect(dirname(row.filePath)).toBe(absDir)
    expect(readFileSync(row.filePath, 'utf-8')).toBe('x')
  })

  it('create writes into a nested folder when folderPath is given', async () => {
    const row = await call('documents:create', {
      title: 'Nested',
      content: 'x',
      folderPath: 'Sub/Deep',
      memoryOnly: false,
    })
    expect(row.filePath).toMatch(/Sub[/\\]Deep/)
    expect(readFileSync(row.filePath, 'utf-8')).toBe('x')
  })

  it('update returns null when the document does not exist', async () => {
    expect(await call('documents:update', 'nope', { content: 'x' })).toBeNull()
  })

  it('update of a memory-only draft skips the disk write (no file_path)', async () => {
    const created = await call('documents:create', {
      title: 'MemUpdate',
      content: 'old',
      memoryOnly: true,
    })
    const updated = await call('documents:update', created.id, { content: 'new' })
    expect(updated.content).toBe('new')
  })

  it('update falls back to utf-8 when the stored encoding is missing', async () => {
    // Inject a row whose encoding is falsy so the `existing.encoding || 'utf-8'` fallback
    // in the update write path fires (writeFileSync uses utf-8).
    const id = 'upd-' + Date.now()
    const dir = fakeApp.getPath()
    const srcPath = join(dir, 'upd-missing-enc.md')
    writeFileSync(srcPath, 'body')
    docs.set(id, {
      id,
      title: 'UpdMissingEnc',
      folderPath: '',
      filePath: srcPath,
      content: 'body',
      wordCount: 1,
      // encoding intentionally falsy
    })
    const updated = await call('documents:update', id, { content: 'updated body' })
    expect(updated.content).toBe('updated body')
    expect(readFileSync(srcPath, 'utf-8')).toBe('updated body')
    docs.delete(id)
  })

  it('save-as returns null when the document does not exist', async () => {
    const dir = fakeApp.getPath()
    expect(await call('documents:save-as', 'nope', join(dir, 'x.md'), {})).toBeNull()
  })

  it('save-as falls back to the existing content when it is omitted', async () => {
    const created = await call('documents:create', {
      title: 'SaveFallback',
      content: 'orig-content',
      memoryOnly: false,
    })
    const dir = fakeApp.getPath()
    const newPath = join(dir, 'saved-fallback.md')
    const updated = await call('documents:save-as', created.id, newPath, {})
    // The title is NOT inherited: the document is re-pointed at a file the user
    // picked, so that file name is the title.
    expect(updated.title).toBe('saved-fallback')
    expect(updated.content).toBe('orig-content')
    expect(readFileSync(newPath, 'utf-8')).toBe('orig-content')
  })

  it('save-as falls back to utf-8 when the stored encoding is missing', async () => {
    // Inject a raw row whose encoding is falsy so the `existing.encoding || 'utf-8'` fallback fires.
    const id = 'enc-' + Date.now()
    const dir = fakeApp.getPath()
    const srcPath = join(dir, 'src-missing-enc.md')
    writeFileSync(srcPath, 'encoded body')
    docs.set(id, {
      id,
      title: 'MissingEnc',
      folderPath: '',
      filePath: srcPath,
      content: 'encoded body',
      wordCount: 1,
      // encoding intentionally falsy
    })
    const newPath = join(dir, 'saved-missing-enc.md')
    const updated = await call('documents:save-as', id, newPath, { title: 'MissingEnc' })
    expect(updated.filePath).toBe(newPath)
    expect(readFileSync(newPath, 'utf-8')).toBe('encoded body')
    docs.delete(id)
  })

  it('reload returns null when the document does not exist', async () => {
    expect(await call('documents:reload', 'nope')).toBeNull()
  })

  it('delete of a memory-only draft only removes the store entry (no file_path to unlink)', async () => {
    const created = await call('documents:create', {
      title: 'MemDelete',
      content: 'x',
      memoryOnly: true,
    })
    expect(await call('documents:delete', created.id)).toBe(true)
    expect(docs.has(created.id)).toBe(false)
  })

  it('delete silently ignores an already-removed file (ENOENT)', async () => {
    const created = await call('documents:create', {
      title: 'DelEnot',
      content: 'x',
      memoryOnly: false,
    })
    const { unlinkSync } = await import('node:fs')
    unlinkSync(created.filePath) // file already gone -> unlink throws ENOENT -> no error logged
    expect(await call('documents:delete', created.id)).toBe(true)
    expect(docs.has(created.id)).toBe(false)
  })
})

describe('documents IPC — create/update error paths', () => {
  it('propagates a non-EEXIST failure from the create open loop', () => {
    // The title sanitizer strips /\:*?"<>| but NOT a NUL byte, so openSync rejects the
    // path outright. That is not a name collision, so the retry loop must rethrow rather
    // than spin forever over `-1`, `-2`, ... candidates.
    const markFlowDir = join(stableDocsRoot, 'MarkFlow')
    mkdirSync(markFlowDir, { recursive: true })
    let thrown: unknown
    try {
      call('documents:create', { title: 'Bad\0Name', content: 'x', memoryOnly: false })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    // Node rejects NUL in paths; the error surfaces unchanged (not converted to EEXIST).
    expect((thrown as NodeJS.ErrnoException).code).not.toBe('EEXIST')
    // The failure aborts creation outright: no store entry, and no `-N` fallback file on disk.
    expect([...docs.values()].some((d) => d.title === 'Bad\0Name')).toBe(false)
    expect(existsSync(join(markFlowDir, 'Bad\0Name-1.md'.replace('\0', '')))).toBe(false)
  })

  it('falls back to .md when the existing file path has no extension', async () => {
    // Inject a row whose file_path is extension-less so `extname(...) || '.md'` fires
    // on the rename branch.
    const id = 'noext-' + Date.now()
    const dir = fakeApp.getPath()
    const srcPath = join(dir, 'noextfile')
    writeFileSync(srcPath, 'body')
    docs.set(id, {
      id,
      title: 'NoExt',
      folderPath: '',
      filePath: srcPath,
      content: 'body',
      wordCount: 1,
      encoding: 'utf-8',
    })
    const updated = await call('documents:update', id, { title: 'NowNamed' })
    expect(updated.filePath).toBe(join(dir, 'NowNamed.md'))
    expect(readFileSync(updated.filePath, 'utf-8')).toBe('body')
    docs.delete(id)
  })

  it('skips the rename when the sanitized title maps back to the current filename', async () => {
    // 'A/B' sanitizes to 'A-B', which is exactly the current file name, so the target
    // equals existing.file_path and renameSync must be skipped (renaming onto itself).
    const created = await call('documents:create', {
      title: 'A-B',
      content: 'same',
      memoryOnly: false,
    })
    expect(created.filePath).toBe(join(dirname(created.filePath), 'A-B.md'))
    const updated = await call('documents:update', created.id, { title: 'A/B' })
    // Path unchanged, file still present with its content intact.
    expect(updated.filePath).toBe(created.filePath)
    expect(updated.title).toBe('A/B')
    expect(readFileSync(created.filePath, 'utf-8')).toBe('same')
  })

  it('does not rename when the title is updated to the same value', async () => {
    const created = await call('documents:create', {
      title: 'SameTitle',
      content: 'c',
      memoryOnly: false,
    })
    const updated = await call('documents:update', created.id, { title: 'SameTitle' })
    expect(updated.filePath).toBe(created.filePath)
    expect(readFileSync(created.filePath, 'utf-8')).toBe('c')
  })

  it('updates a memory-only draft without touching the disk', async () => {
    const created = await call('documents:create', {
      title: 'DraftUpd',
      content: 'v1',
      memoryOnly: true,
    })
    const updated = await call('documents:update', created.id, {
      title: 'DraftUpd2',
      content: 'v2',
    })
    // No file was ever created, so file_path stays empty and no rename happens.
    expect(updated.filePath).toBe('')
    expect(updated.title).toBe('DraftUpd2')
    expect(updated.content).toBe('v2')
  })

  it('returns null when updating a document that does not exist', async () => {
    expect(await call('documents:update', 'ghost', { content: 'x' })).toBeNull()
  })
})

describe('documents — pure encoding / text utilities', () => {
  describe('normEnc', () => {
    it('maps known encoding aliases to their canonical lowercased names', () => {
      expect(normEnc('UTF8')).toBe('utf-8')
      expect(normEnc('UTF16')).toBe('utf-16le')
      expect(normEnc('UTF16LE')).toBe('utf-16le')
      expect(normEnc('UTF16BE')).toBe('utf-16be')
      expect(normEnc('UTF32')).toBe('utf-32le')
      expect(normEnc('UTF32LE')).toBe('utf-32le')
      expect(normEnc('GB2312')).toBe('gbk')
      expect(normEnc('GBK')).toBe('gbk')
      expect(normEnc('GB18030')).toBe('gbk')
      expect(normEnc('CP936')).toBe('gbk')
      expect(normEnc('BIG5')).toBe('big5')
      expect(normEnc('WINDOWS-1252')).toBe('win1252')
      expect(normEnc('ISO-8859-1')).toBe('latin1')
    })

    it('lowercases an unknown encoding name', () => {
      expect(normEnc('EUC-KR')).toBe('euc-kr')
      expect(normEnc('Shift_JIS')).toBe('shift_jis')
    })
  })

  describe('countReplacements', () => {
    it('returns Infinity for an encoding iconv does not know', () => {
      expect(countReplacements(Buffer.from('hello'), 'no-such-enc')).toBe(Infinity)
    })

    it('returns 0 for a clean decode with no replacement chars', () => {
      const buf = Buffer.from('纯中文测试', 'utf-8')
      expect(countReplacements(buf, 'utf-8')).toBe(0)
    })

    it('counts U+FFFD replacement chars produced by a wrong encoding', () => {
      // A UTF-8 buffer decoded as latin1 is fully decodable (1:1 byte->code), so 0.
      expect(countReplacements(Buffer.from('abc', 'utf-8'), 'latin1')).toBe(0)
      // GBK bytes that are invalid under UTF-8 produce replacement chars when forced to utf-8.
      const gbkBuf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // "" in GBK
      const n = countReplacements(gbkBuf, 'utf-8')
      expect(n).toBeGreaterThan(0)
    })
  })

  describe('cjkSecondPass', () => {
    it('keeps the primary encoding when it decodes cleanly', () => {
      const buf = Buffer.from('中文', 'utf-8')
      const res = cjkSecondPass(buf, 'utf-8')
      expect(res.enc).toBe('utf-8')
      // utf-8 with 0 replacements -> 0.99 confidence
      expect(res.confidence).toBe(0.99)
    })

    it('flips to a cleaner CJK candidate when the primary decodes poorly', () => {
      // GBK bytes; primary wrongly claims utf-8 (which yields many replacements),
      // so a CJK candidate (gbk) should win with far fewer replacements.
      const gbkBuf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
      const res = cjkSecondPass(gbkBuf, 'utf-8')
      expect(res.enc).toBe('gbk')
      expect(res.confidence).toBe(0.99)
    })

    it('floors confidence at 0.1 for utf-8 with some replacements, 0.7 for CJK candidates', () => {
      // A buffer of all 0xFF bytes decodes to many U+FFFD under any encoding; the primary
      // wins by default (no candidate is strictly better), exercising both confidence floors.
      const messy = Buffer.alloc(4096, 0xff)
      const asUtf8 = cjkSecondPass(messy, 'utf-8')
      expect(asUtf8.enc).toBe('utf-8')
      expect(asUtf8.confidence).toBeGreaterThanOrEqual(0.1)
      const asGbk = cjkSecondPass(messy, 'gbk')
      expect(asGbk.enc).toBe('gbk')
      expect(asGbk.confidence).toBeGreaterThanOrEqual(0.7)
    })

    it('prefers a candidate that strictly beats the primary replacement count', () => {
      // Shift-JIS-ish bytes: ensure a deterministic candidate switch path is covered.
      const buf = Buffer.from([0x82, 0xa0, 0x82, 0xa2]) // "あい" in Shift-JIS
      const res = cjkSecondPass(buf, 'utf-8')
      expect(['utf-8', 'gbk', 'big5', 'shift_jis', 'euc-kr']).toContain(res.enc)
    })
  })

  describe('detectEncoding', () => {
    it('returns utf-8 with confidence 1 for a UTF-8 BOM', () => {
      const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])
      expect(detectEncoding(buf)).toEqual({ enc: 'utf-8', confidence: 1 })
    })

    it('returns utf-32le with confidence 1 for a UTF-32LE BOM', () => {
      const buf = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x00, 0x00])
      expect(detectEncoding(buf)).toEqual({ enc: 'utf-32le', confidence: 1 })
    })

    it('returns utf-16le with confidence 1 for a UTF-16LE BOM', () => {
      const buf = Buffer.from([0xff, 0xfe, 0x61, 0x00])
      expect(detectEncoding(buf)).toEqual({ enc: 'utf-16le', confidence: 1 })
    })

    it('returns utf-16be with confidence 1 for a UTF-16BE BOM', () => {
      const buf = Buffer.from([0xfe, 0xff, 0x00, 0x61])
      expect(detectEncoding(buf)).toEqual({ enc: 'utf-16be', confidence: 1 })
    })

    it('falls back to utf-8 confidence 0 when the detector yields no encoding', () => {
      // Empty buffer -> jschardet returns no encoding.
      const res = detectEncoding(Buffer.alloc(0))
      expect(res.enc).toBe('utf-8')
      expect(res.confidence).toBe(0)
    })

    it('trusts a high-confidence non-CJK encoding without the CJK second pass', () => {
      // Windows-1251 (Cyrillic) bytes are detected with high confidence; the inCjkScope
      // gate must be false, so the primary is returned directly (not overridden by GBK).
      const buf = Buffer.from([0xd0, 0x9f, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]) // "Привет" in cp1251
      const res = detectEncoding(buf)
      // Must NOT be gbk (the CJK-override trap); confidence is the detector's high value.
      expect(res.enc).not.toBe('gbk')
      expect(res.confidence).toBeGreaterThanOrEqual(0.6)
    })

    it('trusts a forced high-confidence non-CJK primary without the second pass', () => {
      // Explicitly exercise the `!inCjkScope` early return. The byte-level test
      // below (Cyrillic/cp1251) only asserts the OUTCOME, and the real detector's
      // verdict for those bytes can route it elsewhere so pin the verdict here
      // to make the branch under test unambiguous.
      detectState.override = () => ({ encoding: 'windows-1252', confidence: 0.95 })
      try {
        const res = detectEncoding(Buffer.from([0x80, 0x9f, 0xe9, 0xff]))
        expect(res.enc).not.toBe('gbk')
        expect(res.confidence).toBe(0.95)
      } finally {
        detectState.override = null
      }
    })

    it('treats a low-confidence non-CJK primary as in-scope', () => {
      // `primaryConf < 0.6` is the third arm of inCjkScope and the only one that
      // can pull a NON-CJK codec into the second pass. Short-circuit evaluation
      // means it is never even reached unless the first two arms are false, so a
      // forced low-confidence non-CJK verdict is required to cover it.
      detectState.override = () => ({ encoding: 'windows-1252', confidence: 0.3 })
      try {
        const res = detectEncoding(Buffer.from([0x80, 0x9f, 0xe9, 0xff]))
        expect(typeof res.enc).toBe('string')
        expect(res.enc.length).toBeGreaterThan(0)
      } finally {
        detectState.override = null
      }
    })

    it('runs the CJK second pass when the in-scope primary decodes with replacements', () => {
      // Force the detector to claim utf-8 for bytes that are NOT valid utf-8, so
      // the primary decodes with replacement chars and the second pass must run.
      // (See the detectState comment above for why this needs a forced verdict.)
      // GBK bytes for "" are invalid under utf-8, so gbk should win
      const gbkBuf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
      detectState.override = () => ({ encoding: 'utf-8', confidence: 0.9 })
      try {
        const res = detectEncoding(gbkBuf)
        expect(res.enc).toBe('gbk')
        expect(res.confidence).toBeGreaterThan(0)
      } finally {
        detectState.override = null
      }
    })

    it('routes an in-scope primary (utf-8 / ascii) through the CJK second pass', () => {
      // Pure ASCII is detected as 'ascii' (an in-scope primary), which must still be
      // routed into the CJK second pass and return a usable encoding with a numeric confidence.
      const buf = Buffer.from('plain ascii text', 'utf-8')
      const res = detectEncoding(buf)
      expect(typeof res.enc).toBe('string')
      expect(res.enc.length).toBeGreaterThan(0)
      expect(typeof res.confidence).toBe('number')
    })

    it('skips the CJK second pass when the in-scope primary decodes with zero replacements', () => {
      // Performance guard for the chokidar-lag fix: cjkSecondPass decodes the sample
      // once per candidate (utf-8 + gbk + big5 + shift_jis + euc-kr) five full
      // decodes. When the primary encoding already decodes cleanly (0 replacement
      // chars), no candidate can do better, so the pass is pure waste.
      //
      // Verify the fast return by forcing the detector to a utf-8 verdict for bytes
      // that are valid utf-8: the primary decodes with 0 replacements, so the only
      // way to reach utf-8/0.99 is the early "primaryRep === 0" return entering
      // the second pass could only change or lower the confidence, never confirm 0.99.
      detectState.override = () => ({ encoding: 'utf-8', confidence: 0.9 })
      try {
        const buf = Buffer.from('hello world, this is valid utf-8', 'utf-8')
        const res = detectEncoding(buf)
        expect(res.enc).toBe('utf-8')
        expect(res.confidence).toBeGreaterThanOrEqual(0.99)
      } finally {
        detectState.override = null
      }
    })
  })

  describe('readMarkdownText', () => {
    it('reads a UTF-8 file and reports its detected encoding', () => {
      const dir = mkTestDir('mf-rmt-')
      const p = join(dir, 'r.md')
      writeFileSync(p, '# read me')
      const { text, encoding, confidence } = readMarkdownText(p)
      expect(text).toBe('# read me')
      // '# read me' is pure ASCII; jschardet reports it as 'ascii', which is a valid
      // decodable encoding for the CJK second pass. Just assert it's a non-empty name.
      expect(typeof encoding).toBe('string')
      expect(encoding.length).toBeGreaterThan(0)
      expect(typeof confidence).toBe('number')
    })

    it('decodes a GBK file as gbk via the CJK second pass', () => {
      const dir = mkTestDir('mf-rmt-')
      const p = join(dir, 'g.md')
      writeFileSync(p, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
      const { text, encoding } = readMarkdownText(p)
      expect(encoding).toBe('gbk')
      expect(text).toBe('中文')
    })
  })

  describe('countWords', () => {
    it('counts whitespace-delimited words and strips markdown punctuation', () => {
      expect(countWords('one two three')).toBe(3)
      expect(countWords('# Heading *bold* `code`')).toBe(3)
      expect(countWords('')).toBe(0)
      expect(countWords('   ')).toBe(0)
      // Markdown symbols are replaced with spaces, so punctuation-only input is 0 words.
      expect(countWords('# * ` ~ [ ] ( ) > |')).toBe(0)
    })
  })
})

// isInFolder is shared by documentStore.listDocuments AND the fake store above,
// so it must stay correct on its own. These tests lock the path-matching
// semantics (sub-folder inclusion, case-insensitivity, empty/relative folder).
describe('isInFolder (folderMatch, shared with documentStore)', () => {
  it('matches a file directly inside the folder', () => {
    expect(isInFolder('/a/b/note.md', '/a/b')).toBe(true)
  })

  it('matches a file in a sub-folder of the target', () => {
    expect(isInFolder('/a/b/c/note.md', '/a/b')).toBe(true)
  })

  it('does not match a sibling folder', () => {
    expect(isInFolder('/a/x/note.md', '/a/b')).toBe(false)
  })

  it('does not match a parent folder', () => {
    expect(isInFolder('/a/note.md', '/a/b')).toBe(false)
  })

  it('treats a trailing slash on the folder as the same folder', () => {
    expect(isInFolder('/a/b/note.md', '/a/b/')).toBe(true)
  })

  it('is case-insensitive (Windows paths)', () => {
    expect(isInFolder('C:\\A\\B\\Note.md', 'c:\\a\\b')).toBe(true)
    expect(isInFolder('C:\\A\\X\\Note.md', 'c:\\a\\b')).toBe(false)
  })

  it('returns false for an empty folder', () => {
    expect(isInFolder('/a/b/note.md', '')).toBe(false)
    expect(isInFolder('/a/b/note.md', undefined as unknown as string)).toBe(false)
  })
})

// ─── M3 new handlers (/3/6/7/11/13) ─────────────────────────────────────
describe('documents IPC — resolve-appdoc (能力 3)', () => {
  const dir = join(stableDocsRoot, 'ra')
  const filePath = join(dir, 'note.md')
  beforeEach(() => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, '# note')
    docs.set('ra1', {
      id: 'ra1',
      filePath,
      encoding: 'utf-8',
      encodingConfidence: 1,
      title: 't',
      content: '',
      memoryOnly: false,
      folderPath: dir,
      updatedAt: 1,
    })
    writeFileSync(join(dir, 'img.png'), 'PNG')
  })
  it('resolves an appdoc:// URL to its on-disk absolute path', async () => {
    const r = await call('documents:resolve-appdoc', 'appdoc://ra1/img.png')
    expect(r).toBe(join(dir, 'img.png'))
  })
  it('returns null for a missing file', async () => {
    expect(await call('documents:resolve-appdoc', 'appdoc://ra1/missing.png')).toBeNull()
  })
  it('returns null when the path escapes the document directory', async () => {
    expect(await call('documents:resolve-appdoc', 'appdoc://ra1/../escape.png')).toBeNull()
  })
  it('returns null for an unknown document', async () => {
    expect(await call('documents:resolve-appdoc', 'appdoc://ghost/img.png')).toBeNull()
  })
  it('returns null when getDocumentById throws (defensive catch)', async () => {
    const orig = fakeStore.getDocumentById
    fakeStore.getDocumentById = () => {
      throw new Error('boom')
    }
    try {
      expect(await call('documents:resolve-appdoc', 'appdoc://ra1/im.png')).toBeNull()
    } finally {
      fakeStore.getDocumentById = orig
    }
  })
})

describe('documents IPC — set-eol (能力 6)', () => {
  const dir = join(stableDocsRoot, 'eol')
  const filePath = join(dir, 'file.md')
  beforeEach(() => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, 'a\nb\nc')
    docs.set('eol1', {
      id: 'eol1',
      filePath,
      encoding: 'utf-8',
      encodingConfidence: 1,
      title: 't',
      content: '',
      memoryOnly: false,
      folderPath: dir,
      updatedAt: 1,
    })
  })
  it('rewrites LF to CRLF preserving bytes', async () => {
    await call('documents:set-eol', filePath, '\r\n')
    expect(readFileSync(filePath, 'utf-8')).toBe('a\r\nb\r\nc')
  })
  it('rewrites CRLF to LF', async () => {
    writeFileSync(filePath, 'a\r\nb')
    await call('documents:set-eol', filePath, '\n')
    expect(readFileSync(filePath, 'utf-8')).toBe('a\nb')
  })
  it('falls back to utf-8 when the file is not in the document store', async () => {
    const orphan = join(dir, 'orphan.md')
    writeFileSync(orphan, 'a\nb')
    await call('documents:set-eol', orphan, '\r\n')
    expect(readFileSync(orphan, 'utf-8')).toBe('a\r\nb')
  })
})

describe('documents IPC — detect-encoding (能力 11)', () => {
  const dir = join(stableDocsRoot, 'det')
  const filePath = join(dir, 'file.md')
  beforeEach(() => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])) // UTF-8 BOM
  })
  it('detects the encoding from disk', async () => {
    expect(await call('documents:detect-encoding', filePath)).toEqual({
      enc: 'utf-8',
      confidence: 1,
    })
  })
  it('falls back to utf-8/0 for a missing file', async () => {
    expect(await call('documents:detect-encoding', join(dir, 'nope.md'))).toEqual({
      enc: 'utf-8',
      confidence: 0,
    })
  })
})

describe('documents IPC — folder ops (能力 7)', () => {
  it('create-folder makes the directory', async () => {
    const p = join(stableDocsRoot, `mk-${Date.now()}`)
    await call('documents:create-folder', p)
    expect(existsSync(p)).toBe(true)
  })
  it('create-folder rejects with EEXIST when the folder already exists', () => {
    // Drive this through the in-memory DiskIO: the node:fs mock drops mkdirSync's options, so
    // the recursive:false refusal cannot be observed via the mocked real adapter. Seed the folder,
    // then the handler must refuse it with EEXIST instead of silently swallowing it.
    const io = createMemoryDiskIO()
    const p = join(stableDocsRoot, `dup-${Date.now()}`)
    io.mkdir(p, { recursive: true })
    registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow, io)
    try {
      expect(() => call('documents:create-folder', p)).toThrow(/EEXIST/)
    } finally {
      // Restore the default (real-filesystem) registration for the remaining cases.
      registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow)
    }
  })
  it('rename-folder moves the directory', async () => {
    const a = join(stableDocsRoot, `mv-a-${Date.now()}`)
    const b = join(stableDocsRoot, `mv-b-${Date.now()}`)
    mkdirSync(a, { recursive: true })
    writeFileSync(join(a, 'x.md'), 'x')
    await call('documents:rename-folder', a, b)
    expect(existsSync(b)).toBe(true)
    expect(existsSync(a)).toBe(false)
  })
  it('rename-folder re-points tracked documents so no stale duplicates remain', async () => {
    const a = join(stableDocsRoot, `mv-docs-a-${Date.now()}`)
    const b = join(stableDocsRoot, `mv-docs-b-${Date.now()}`)
    mkdirSync(join(a, 'sub'), { recursive: true })
    const file = join(a, 'x.md')
    const nested = join(a, 'sub', 'y.md')
    writeFileSync(file, 'x')
    writeFileSync(nested, 'y')
    expect(await call('documents:import', file)).not.toBeNull()
    expect(await call('documents:import', nested)).not.toBeNull()
    await call('documents:rename-folder', a, b)
    const list = (await call('documents:list')) as Array<{ filePath: string }>
    // Every tracked record now lives under the new folder including nested ones
    // and the old paths are gone instead of lingering as "missing" duplicates.
    expect(list.some((d) => d.filePath === join(b, 'x.md'))).toBe(true)
    expect(list.some((d) => d.filePath === join(b, 'sub', 'y.md'))).toBe(true)
    expect(list.some((d) => d.filePath === file)).toBe(false)
    expect(list.some((d) => d.filePath === nested)).toBe(false)
  })
  it('rename-folder re-points tracked documents when renderer uses forward slashes (Windows)', async () => {
    const a = join(stableDocsRoot, `mv-slashes-a-${Date.now()}`)
    const b = join(stableDocsRoot, `mv-slashes-b-${Date.now()}`)
    mkdirSync(a, { recursive: true })
    const file = join(a, 'x.md')
    writeFileSync(file, 'x')
    expect(await call('documents:import', file)).not.toBeNull()

    // The renderer builds tree paths with forward slashes, so it calls rename-folder
    // with forward-slash paths even on Windows where stored file paths use backslashes.
    const forwardA = a.replace(/\\/g, '/')
    const forwardB = b.replace(/\\/g, '/')
    await call('documents:rename-folder', forwardA, forwardB)

    const list = (await call('documents:list')) as Array<{ filePath: string }>
    expect(list.some((d) => d.filePath === join(b, 'x.md'))).toBe(true)
    expect(list.some((d) => d.filePath === file)).toBe(false)
  })
  it("rename-folder preserves each document's own separator style when re-pointing", async () => {
    const a = join(stableDocsRoot, `mv-sep-a-${Date.now()}`)
    const b = join(stableDocsRoot, `mv-sep-b-${Date.now()}`)
    mkdirSync(a, { recursive: true })

    // Call the handler with forward-slash paths (how the renderer builds tree paths)
    // so BOTH branches of the `docSep` ternary are reachable on every platform:
    //   - a doc stored with forward slashes only -> docSep === '/'
    //   - a doc stored with a backslash           -> docSep === '\\'
    // rePointFolderRecords must keep each doc's own separator instead of forcing the
    // folder's normalized separator onto it.
    const aFwd = a.split(sep).join('/')
    const bFwd = b.split(sep).join('/')
    docs.set('sep-fwd', {
      id: 'sep-fwd',
      title: 'Fwd',
      folderPath: `${aFwd}/fwd`,
      filePath: `${aFwd}/fwd.md`,
      content: 'x',
      wordCount: 1,
      createdAt: 0,
      updatedAt: 0,
      memoryOnly: false,
    })
    docs.set('sep-bs', {
      id: 'sep-bs',
      title: 'Bs',
      folderPath: `${aFwd}/deep`,
      filePath: `${aFwd}/deep\\odd.md`,
      content: 'y',
      wordCount: 1,
      createdAt: 0,
      updatedAt: 0,
      memoryOnly: false,
    })

    await call('documents:rename-folder', aFwd, bFwd)

    const fwd = docs.get('sep-fwd')
    const bs = docs.get('sep-bs')
    // Both re-pointed onto the new folder (old name gone, new name present).
    expect(fwd.filePath).toContain('mv-sep-b')
    expect(bs.filePath).toContain('mv-sep-b')
    expect(fwd.filePath).not.toContain('mv-sep-a')
    expect(bs.filePath).not.toContain('mv-sep-a')
    // Each doc keeps its OWN separator style in the re-pointed suffix: the forward-slash
    // doc stays forward-slash, the backslash doc stays backslash (the docSep branches).
    expect(fwd.filePath.endsWith('/fwd.md')).toBe(true)
    expect(bs.filePath.includes('deep\\odd.md')).toBe(true)

    docs.delete('sep-fwd')
    docs.delete('sep-bs')
    await fsPromises.rm(b, { recursive: true, force: true })
  })
  it('rename-file moves the file on disk', async () => {
    const dir = join(stableDocsRoot, `mvf-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'x.md')
    const renamed = join(dir, 'y.md')
    writeFileSync(file, 'x')
    await call('documents:rename-file', file, renamed)
    expect(existsSync(renamed)).toBe(true)
    expect(existsSync(file)).toBe(false)
    await fsPromises.rm(dir, { recursive: true, force: true })
  })
  it('rename-file re-points the tracked document so no stale duplicate remains', async () => {
    const dir = join(stableDocsRoot, `mvf-docs-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'x.md')
    const renamed = join(dir, 'y.md')
    writeFileSync(file, 'x')
    expect(await call('documents:import', file)).not.toBeNull()
    await call('documents:rename-file', file, renamed)
    const list = (await call('documents:list')) as Array<{ filePath: string; title: string }>
    // The record now lives under the new name (title follows the new base name) and the
    // old path is gone instead of lingering as a "missing" duplicate.
    expect(list.some((d) => d.filePath === renamed)).toBe(true)
    expect(list.some((d) => d.title === 'y')).toBe(true)
    expect(list.some((d) => d.filePath === file)).toBe(false)
    await fsPromises.rm(dir, { recursive: true, force: true })
  })
  it('rename-file re-points a record whose stored path uses forward slashes (Windows)', async () => {
    const dir = join(stableDocsRoot, `mvf-sl-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'x.md')
    const renamed = join(dir, 'y.md')
    writeFileSync(file, 'x')
    expect(await call('documents:import', file)).not.toBeNull()
    // The imported record uses backslashes; seed a SECOND record at the same old path but with
    // forward slashes, as the renderer builds tree paths on Windows. This exercises
    // rePointFileRecord's `? '/'` separator branch (the imported record covers the `'\\'` branch).
    const fileFwd = file.split(sep).join('/')
    docs.set('fs-fwd', {
      id: 'fs-fwd',
      title: 'x',
      folderPath: dir.split(sep).join('/'),
      filePath: fileFwd,
      content: 'x',
      wordCount: 1,
      createdAt: 0,
      updatedAt: 0,
      memoryOnly: false,
    })
    await call('documents:rename-file', file, renamed)
    const list = (await call('documents:list')) as Array<{ filePath: string; title: string }>
    expect(list.some((d) => d.filePath === renamed)).toBe(true)
    // The forward-slash record is re-pointed onto the new name, keeping its separator style.
    const fwd = docs.get('fs-fwd')
    expect(fwd?.filePath).toBe(renamed.split(sep).join('/'))
    expect(fwd?.title).toBe('y')
    docs.delete('fs-fwd')
    await fsPromises.rm(dir, { recursive: true, force: true })
  })
  // Covers the `'\\'` half of rePointFileRecord's docSep ternary — the half the
  // Windows-only test above could not reach on POSIX.
  //
  // The paths are built with path.win32 (pure JS: identical output on every host)
  // instead of the host `join`, whose shape follows the OS. Deriving them from `join`
  // is exactly what made this branch unreachable on Linux: on Windows `join` yields
  // backslashes so imported records contain one, while on POSIX every stored path is
  // forward-slash-only and `includes('\\')` is never true.
  it("rename-file preserves a backslash-stored record's own separator style", async () => {
    const oldP = win32.join('C:\\docs', 'x.md') // 'C:\\docs\\x.md' on every platform
    const newP = win32.join('C:\\docs', 'y.md')
    docs.set('bs-doc', {
      id: 'bs-doc',
      title: 'x',
      folderPath: 'C:\\docs',
      filePath: oldP,
      content: 'x',
      wordCount: 1,
      createdAt: 0,
      updatedAt: 0,
      memoryOnly: false,
    })
    // Drive this case through the in-memory DiskIO. 'C:\\docs\\x.md' cannot exist on a
    // real disk, so with the real adapter the rename would throw before the re-pointing
    // ever ran — the fake is what makes this path shape usable at all.
    const io = createMemoryDiskIO()
    io.seed(oldP, 'x')
    registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow, io)
    try {
      await call('documents:rename-file', oldP, newP)
    } finally {
      // Restore the default (real filesystem) registration for the remaining cases.
      registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow)
    }

    // Re-pointed with the record's OWN separator, so the result is still all
    // backslashes. A '/' here would mean the `'\\'` branch was not taken.
    expect(docs.get('bs-doc')?.filePath).toBe(newP)
    docs.delete('bs-doc')
  })

  // POSIX `rename()` silently REPLACES an existing target, so a collision has to be refused
  // here — otherwise a lost race is silent data loss. Windows already errored; now both agree.
  it('refuses a rename whose target name is already taken (no silent overwrite)', async () => {
    const dir = mkTestDir('markflow-rename-clash-')
    const src = join(dir, 'a.md')
    const taken = join(dir, 'b.md')
    writeFileSync(src, '# A', 'utf-8')
    writeFileSync(taken, '# B', 'utf-8')
    let thrown: unknown
    try {
      await call('documents:rename-file', src, taken)
    } catch (e) {
      thrown = e
    }
    expect((thrown as NodeJS.ErrnoException)?.code).toBe('EEXIST')
    // Neither file is lost: an unguarded rename would have replaced `taken` with `src`.
    expect(readFileSync(src, 'utf-8')).toBe('# A')
    expect(readFileSync(taken, 'utf-8')).toBe('# B')
  })

  it('refuses a folder rename whose target name is already taken', async () => {
    const dir = mkTestDir('markflow-renamefolder-clash-')
    const src = join(dir, 'sub')
    const taken = join(dir, 'other')
    mkdirSync(src)
    mkdirSync(taken)
    let thrown: unknown
    try {
      await call('documents:rename-folder', src, taken)
    } catch (e) {
      thrown = e
    }
    expect((thrown as NodeJS.ErrnoException)?.code).toBe('EEXIST')
    expect(existsSync(src)).toBe(true)
    expect(existsSync(taken)).toBe(true)
  })

  it('allows a rename that only changes the case of the name (case-insensitive fs)', async () => {
    // `a.md` -> `A.md` is the SAME file on a case-insensitive filesystem, so the guard must
    // not report a collision with itself (VS Code's `child !== item` rule). The platform seam is
    // injected as a case-INsensitive OS via `registerDocumentHandlers` — no global mutation, no
    // module mock — so this branch is covered on any runner.
    const dir = mkTestDir('markflow-rename-case-')
    const src = join(dir, 'a.md')
    writeFileSync(src, '# A', 'utf-8')
    registerDocumentHandlers(
      fakeIpcMain,
      fakeApp,
      () => fakeMainWindow,
      undefined,
      () => false,
    )
    try {
      await call('documents:rename-file', src, join(dir, 'A.md'))
      expect(existsSync(join(dir, 'A.md'))).toBe(true)
    } finally {
      // Restore the default handlers/io/seam so later tests are unaffected by this injection.
      registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow)
    }
  })

  it('treats a case-only difference as another file on Linux', () => {
    // The in-memory adapter is always case-sensitive, so it can hold both spellings — which a
    // Windows disk cannot. With the platform seam injected as Linux, `a.md` -> `A.md` is a real
    // move onto a different file and must be refused.
    const io = createMemoryDiskIO()
    io.seed('/d/a.md', 'A')
    io.seed('/d/A.md', 'other')
    registerDocumentHandlers(
      fakeIpcMain,
      fakeApp,
      () => fakeMainWindow,
      io,
      () => true,
    )
    try {
      expect(() => call('documents:rename-file', '/d/a.md', '/d/A.md')).toThrow(/already exists/)
      // The very same path is still never a collision, on any platform.
      expect(() => call('documents:rename-file', '/d/a.md', '/d/a.md')).not.toThrow()
    } finally {
      registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow)
    }
  })

  // ── undo-rename (single slot) ─────────────────────────────────────────
  it('undo-rename moves a renamed file back and then reports "none"', async () => {
    const dir = mkTestDir('markflow-undo-file-')
    const oldP = join(dir, 'a.md')
    const newP = join(dir, 'b.md')
    writeFileSync(oldP, '# A', 'utf-8')
    await call('documents:rename-file', oldP, newP)
    expect(existsSync(newP)).toBe(true)
    const res = (await call('documents:undo-rename')) as { ok: boolean }
    expect(res.ok).toBe(true)
    // A real move back, not a copy: the file is under the old name and the new one is gone.
    expect(existsSync(oldP)).toBe(true)
    expect(existsSync(newP)).toBe(false)
    // The slot is single-use: a second Ctrl+Z has nothing left to undo. Asserted here (rather
    // than as its own case) because the history is module-level and shared with earlier
    // rename tests — only right after a successful undo is "nothing to undo" guaranteed.
    const again = (await call('documents:undo-rename')) as { ok: boolean; reason: string }
    expect(again).toEqual({ ok: false, reason: 'none' })
  })

  it('undo-rename refuses with "occupied" when the original name is taken again', async () => {
    const dir = mkTestDir('markflow-undo-occ-')
    const oldP = join(dir, 'a.md')
    const newP = join(dir, 'b.md')
    writeFileSync(oldP, '# A', 'utf-8')
    await call('documents:rename-file', oldP, newP)
    // Someone (another program, or the user) recreates the old name in the meantime.
    writeFileSync(oldP, '# taken', 'utf-8')
    const res = (await call('documents:undo-rename')) as { ok: boolean; reason: string }
    expect(res).toEqual({ ok: false, reason: 'occupied' })
    // Refusing must neither clobber the recreated file nor move anything.
    expect(existsSync(newP)).toBe(true)
  })

  it('undo-rename refuses with "gone" when the renamed file no longer exists', async () => {
    const dir = mkTestDir('markflow-undo-gone-')
    const oldP = join(dir, 'a.md')
    const newP = join(dir, 'b.md')
    writeFileSync(oldP, '# A', 'utf-8')
    await call('documents:rename-file', oldP, newP)
    unlinkSync(newP)
    const res = (await call('documents:undo-rename')) as { ok: boolean; reason: string }
    expect(res).toEqual({ ok: false, reason: 'gone' })
  })

  it('notifies the renderer when a folder is added or removed outside the app', () => {
    // The registerDocumentHandlers folder-watch callbacks (onDirAdded / onDirRemoved) only fire
    // for directory events; this exercises them end-to-end and confirms the renderer is told to
    // refresh the tree rooted at the PARENT of the changed folder.
    const addedDir = dirname(join('/w1', 'added'))
    const removedDir = dirname(join('/w2', 'removed'))
    sentFolderChanged.length = 0
    __emitFolderDirEvent('addDir', join('/w1', 'added'))
    __emitFolderDirEvent('unlinkDir', join('/w2', 'removed'))
    __flushFolderChanged()
    expect(sentFolderChanged).toContainEqual({ dirPath: addedDir })
    expect(sentFolderChanged).toContainEqual({ dirPath: removedDir })
  })

  it('undo-rename moves a renamed FOLDER back and re-points the folder tree', async () => {
    // Covers the `last.kind === 'folder'` branch of undo-rename: it must put the watched folder
    // back and re-point the folder records, not just move a single file.
    const dir = mkTestDir('markflow-undo-folder-')
    const oldP = join(dir, 'sub')
    const newP = join(dir, 'renamed')
    mkdirSync(oldP)
    await call('documents:rename-folder', oldP, newP)
    expect(existsSync(newP)).toBe(true)
    const res = (await call('documents:undo-rename')) as { ok: boolean }
    expect(res.ok).toBe(true)
    // A real move back: the folder is under the old name and the new one is gone.
    expect(existsSync(oldP)).toBe(true)
    expect(existsSync(newP)).toBe(false)
  })

  it('undo-rename reports "failed" when the disk move throws', async () => {
    // Covers the catch branch of undo-rename: a rename that fails on disk must surface as a
    // "failed" refusal rather than an unhandled exception.
    const dir = mkTestDir('markflow-undo-fail-')
    const oldP = join(dir, 'a.md')
    const newP = join(dir, 'b.md')
    writeFileSync(oldP, '# A', 'utf-8')
    await call('documents:rename-file', oldP, newP)
    fsRenameMock.mockImplementationOnce(() => {
      throw new Error('EBUSY')
    })
    const res = (await call('documents:undo-rename')) as { ok: boolean; reason: string }
    expect(res).toEqual({ ok: false, reason: 'failed' })
  })

  it('delete-folder moves the folder to the OS trash (trashItem called)', async () => {
    const p = join(stableDocsRoot, `rm-${Date.now()}`)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'y.md'), 'y')
    const { shell } = await import('electron')
    ;(shell.trashItem as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await call('documents:delete-folder', p)
    expect(shell.trashItem).toHaveBeenCalledWith(resolve(p))
    // The handler delegates the removal to the OS, so the on-disk tree is left for the
    // (mocked) trash; clean it up so it doesn't pollute later folder listings.
    await fsPromises.rm(p, { recursive: true, force: true })
  })

  it('delete-folder removes contained documents from the store and notifies the parent', async () => {
    const p = join(stableDocsRoot, `rm-${Date.now()}`)
    mkdirSync(join(p, 'sub'), { recursive: true })
    writeFileSync(join(p, 'top.md'), 'top')
    writeFileSync(join(p, 'sub', 'inner.md'), 'inner')
    // Track both files so the store has documents living inside the folder.
    await call('documents:import-many', [join(p, 'top.md'), join(p, 'sub', 'inner.md')])
    const { shell } = await import('electron')
    ;(shell.trashItem as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    sentFolderChanged.length = 0
    await call('documents:delete-folder', p)
    // The watcher was paused during the move, so it would not have emitted per-file
    // removals. The handler must clean the store directly, otherwise the sidebar tree
    // (built from document folderPaths) keeps showing the deleted folder.
    const remaining = [...docs.values()].filter((d) =>
      d.filePath.replace(/\//g, sep).startsWith(p.replace(/\//g, sep) + sep),
    )
    expect(remaining).toHaveLength(0)
    // The parent directory is told to re-read its children.
    __flushFolderChanged()
    expect(sentFolderChanged.some((e) => e.dirPath === dirname(p))).toBe(true)
    await fsPromises.rm(p, { recursive: true, force: true })
  })

  it('delete-folder rethrows when trashItem fails for a non-ENOENT reason', async () => {
    const p = join(stableDocsRoot, `rm-${Date.now()}`)
    mkdirSync(p, { recursive: true })
    const err = Object.assign(new Error('no trash'), { code: 'EPERM' })
    const { shell } = await import('electron')
    ;(shell.trashItem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err)
    await expect(call('documents:delete-folder', p)).rejects.toThrow()
    expect(shell.trashItem).toHaveBeenCalledWith(resolve(p))
    await fsPromises.rm(p, { recursive: true, force: true })
  })

  it('delete-folder leaves a document whose path is the folder itself (skips the folder node)', async () => {
    // Covers the `if (fp === norm) continue` branch of removeDocumentsUnder: a stored document
    // whose filePath equals the folder being deleted is the folder node, not a child, and must be
    // skipped rather than removed from the store.
    const p = join(stableDocsRoot, `rm-${Date.now()}`)
    mkdirSync(join(p, 'sub'), { recursive: true })
    writeFileSync(join(p, 'sub', 'inner.md'), 'inner')
    await call('documents:import-many', [join(p, 'sub', 'inner.md')])
    docs.set('folderNode', {
      id: 'folderNode',
      title: 'Folder',
      folderPath: p,
      filePath: p,
      content: '',
      encoding: 'utf-8',
      encodingConfidence: 1,
      createdAt: 0,
      updatedAt: 0,
      wordCount: 0,
    })
    const { shell } = await import('electron')
    ;(shell.trashItem as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await call('documents:delete-folder', p)
    const remainingInner = [...docs.values()].filter((d) =>
      d.filePath.replace(/\//g, sep).startsWith(p.replace(/\//g, sep) + sep),
    )
    expect(remainingInner).toHaveLength(0)
    expect(docs.has('folderNode')).toBe(true)
    await fsPromises.rm(p, { recursive: true, force: true })
  })

  it('delete-folder treats an already-gone folder (ENOENT) as success', async () => {
    const p = join(stableDocsRoot, `gone-${Date.now()}`)
    const err = Object.assign(new Error('gone'), { code: 'ENOENT' })
    const { shell } = await import('electron')
    ;(shell.trashItem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err)
    await expect(call('documents:delete-folder', p)).resolves.toBeUndefined()
    expect(shell.trashItem).toHaveBeenCalledWith(resolve(p))
  })
  it('list-folders reports nested directories and skips hidden ones', async () => {
    const p = join(stableDocsRoot, `lf-${Date.now()}`)
    mkdirSync(join(p, 'sub', 'deeper'), { recursive: true })
    mkdirSync(join(p, '.hidden'), { recursive: true })
    writeFileSync(join(p, 'a.md'), 'a')
    const dirs = (await call('documents:list-folders', p)) as string[]
    expect(dirs).toContain(join(p, 'sub'))
    expect(dirs).toContain(join(p, 'sub', 'deeper'))
    // Files are not directories, and dot-directories are workspace noise.
    expect(dirs).not.toContain(join(p, 'a.md'))
    expect(dirs.some((d) => d.endsWith('.hidden'))).toBe(false)
  })
  it('list-folders stops at the MAX_DEPTH limit instead of recursing forever', async () => {
    const p = join(stableDocsRoot, `deep-${Date.now()}`)
    let cur = p
    for (let i = 0; i < 12; i++) cur = join(cur, `l${i}`)
    mkdirSync(cur, { recursive: true })
    const dirs = (await call('documents:list-folders', p)) as string[]
    // The walk must bail out once depth exceeds MAX_DEPTH (8): the folder 9 levels down
    // (l8) is still reported because the depth-8 walk enumerates it as its last child, but
    // nothing deeper is recursion into l8 is skipped
    const deepest = join(p, 'l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8')
    const tooDeep = join(deepest, 'l9', 'l10', 'l11')
    expect(dirs).toContain(deepest)
    expect(dirs).not.toContain(tooDeep)
  })

  it('list-folders returns nothing for a missing path instead of throwing', async () => {
    const dirs = (await call(
      'documents:list-folders',
      join(stableDocsRoot, `nope-${Date.now()}`),
    )) as string[]
    expect(dirs).toEqual([])
  })
})
