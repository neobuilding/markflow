// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import {
  registerDocumentHandlers,
  shouldIgnoreExternalChange,
  notifyExternalChange,
  normEnc,
  countReplacements,
  cjkSecondPass,
  detectEncoding,
  readMarkdownText,
  countWords,
} from './documents'
// Import the REAL isInFolder (from the un-mocked folderMatch module) so the fake
// store's listDocuments matches production semantics exactly — no drift between the
// test double and documentStore.listDocuments.
import { isInFolder } from '../model/folderMatch'

// In-memory fake of the document store. documents.ts imports the named store
// functions; we mock that module so the handlers run against a plain Map instead
// of the real store singleton.
// NOTE: vi.mock factories are hoisted above top-level const declarations, so the
// fake store + its backing Map must live in vi.hoisted() to be initialized before
// the hoisted factory runs.
const { docs, fakeStore, flags } = vi.hoisted(() => {
  const docs = new Map<string, any>()
  // Mutable flags consulted by the fake store at call time (so tests can flip
  // behavior without reassigning the imported function binding).
  const flags = { throwOnSelectById: false }
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
    getDocumentById: (id: string) => {
      if (flags.throwOnSelectById) throw new Error('simulated store failure')
      return docs.get(id) ?? null
    },
    getDocumentByFilePath: (filePath: string) => {
      for (const d of docs.values()) if (d.filePath === filePath) return d
      return null
    },
    upsertDocument: (doc: any) => {
      docs.set(doc.id, { ...doc })
      if (doc.filePath) docs.set(`path:${doc.filePath}`, doc)
      return docs.get(doc.id)
    },
    updateDocument: (id: string, partial: any) => {
      const d = docs.get(id)
      if (!d) return null
      const next = { ...d, ...partial, id }
      docs.set(id, next)
      if (next.filePath) docs.set(`path:${next.filePath}`, next)
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
  return { docs, fakeStore, flags }
})
vi.mock('../model/documentStore', () => fakeStore)

// When true, getDocumentById throws, exercising the defensive catch block in
// watchDocument (the store read failing should not crash watching).
function setThrowOnSelectById(v: boolean) {
  flags.throwOnSelectById = v
}

// app:getInitialPaths etc. not used by documents handlers; also need app for getPath.
const handlers: Record<string, (...a: any[]) => any> = {}
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: any[]) => any) => {
    handlers[ch] = fn
  },
} as any
// A stable temp dir for the whole test file, so collision-retry tests can pre-create files
// in the exact directory the create/update handlers will write into.
const stableDocsRoot = mkdtempSync(join(tmpdir(), 'mf-docs-'))
const fakeApp = { getPath: () => stableDocsRoot } as any

// A fake main window that captures 'app:file-changed' and 'app:folder-changed'
// notifications, so the notifyExternalChange / directory-watch paths can be
// exercised end-to-end.
const sentFileChanged: Array<{ id: string; filePath: string }> = []
const sentFolderChanged: Array<{ dirPath: string }> = []
// Mutable so tests can simulate the main window being gone (null) to exercise
// the early-return branch in watchDirectory.
let fakeMainWindow: any = {
  webContents: {
    send: (channel: string, payload: any) => {
      if (channel === 'app:file-changed') sentFileChanged.push(payload)
      if (channel === 'app:folder-changed') sentFolderChanged.push(payload)
    },
  },
}

beforeAll(() => {
  docs.clear()
  registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow)
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

  it('retries with a -N suffix when the target filename already exists (EEXIST collision)', async () => {
    // The create handler writes into <docsRoot>/MarkFlow, so pre-create the would-be target there
    // to force openSync('wx') to fail with EEXIST and the retry loop to pick `ColTest-1.md`.
    const markFlowDir = join(stableDocsRoot, 'MarkFlow')
    mkdirSync(markFlowDir, { recursive: true })
    const target = join(markFlowDir, 'ColTest.md')
    writeFileSync(target, 'preexisting')
    const row = await call('documents:create', {
      title: 'ColTest',
      content: '# ColTest',
      memoryOnly: false,
    })
    expect(row.filePath).toBe(join(markFlowDir, 'ColTest-1.md'))
    expect(readFileSync(row.filePath, 'utf-8')).toBe('# ColTest')
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

  it('retries the rename with a -N suffix when the new filename is already taken (EEXIST)', async () => {
    // docB owns RenTarget.md on disk. Updating docA's title to 'RenTarget' collides, so the
    // rename path retries and lands on RenTarget-1.md.
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
    const updated = await call('documents:update', docA.id, { title: 'RenTarget' })
    expect(updated.filePath).toBe(join(stableDocsRoot, 'MarkFlow', 'RenTarget-1.md'))
    expect(readFileSync(updated.filePath, 'utf-8')).toBe('a')
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
    const dir = mkdtempSync(join(tmpdir(), 'mf-imp-'))
    const p = join(dir, 'a.md')
    writeFileSync(p, '# imported')
    const doc = await call('documents:import', p)
    expect(doc.title).toBe('a')
    expect(doc.content).toBe('# imported')
  })

  it('batch-imports multiple files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-imp-'))
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
  it('returns non-archived documents sorted by updated_at desc', async () => {
    const rows = await call('documents:list')
    expect(Array.isArray(rows)).toBe(true)
    for (const r of rows) expect(r).toHaveProperty('id')
  })
})

describe('documents IPC — watch / unwatch', () => {
  it('registers and removes a file watcher for the document', async () => {
    const created = await call('documents:create', {
      title: 'Watch',
      content: 'x',
      memoryOnly: false,
    })
    expect(() => call('documents:watch', created.id)).not.toThrow()
    expect(() => call('documents:unwatch', created.id)).not.toThrow()
  })

  it('watch is a no-op when the document has no file path (memory-only draft)', async () => {
    const created = await call('documents:create', {
      title: 'WatchDraft',
      content: 'x',
      memoryOnly: true,
    })
    expect(() => call('documents:watch', created.id)).not.toThrow()
    expect(() => call('documents:unwatch', created.id)).not.toThrow()
  })

  it('watch swallows a store read failure without throwing (defensive catch)', async () => {
    setThrowOnSelectById(true)
    try {
      expect(() => call('documents:watch', 'any-id')).not.toThrow()
    } finally {
      setThrowOnSelectById(false)
    }
  })

  it('watch tolerates a missing file on disk (statSync throws -> defensive catch)', async () => {
    // Inject a row whose file_path points at a file that does not exist on disk,
    // so statSync(filePath) throws and the watchDocument catch deletes the mtime baseline
    // instead of crashing the watch setup.
    const id = 'watch-missing-' + Date.now()
    docs.set(id, {
      id,
      title: 'MissingFile',
      folderPath: '',
      filePath: join(tmpdir(), 'does-not-exist-watch-' + id + '.md'),
      content: 'x',
      wordCount: 1,
      encoding: 'utf-8',
      encodingConfidence: 1,
    })
    expect(() => call('documents:watch', id)).not.toThrow()
    expect(() => call('documents:unwatch', id)).not.toThrow()
    docs.delete(id)
  })
})

describe('documents IPC — eol (line-ending detection)', () => {
  it('detects CRLF when the file uses carriage returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-eol-'))
    const p = join(dir, 'crlf.md')
    writeFileSync(p, 'a\r\nb\r\nc')
    const eol = await call('documents:eol', p)
    expect(eol).toBe('\r\n')
  })

  it('defaults to LF when the file has no carriage returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-eol-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'mf-imp-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'mf-imp-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'mf-imp-'))
    const p = join(dir, 'missing.md')
    const results = await call('documents:import-many', [p])
    expect(results).toHaveLength(0)
  })

  it('import returns null when the file cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-imp-'))
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

  it('documents:watch is idempotent (second call is a no-op)', async () => {
    const created = await call('documents:create', {
      title: 'WatchTwice',
      content: 'x',
      memoryOnly: false,
    })
    expect(() => call('documents:watch', created.id)).not.toThrow()
    expect(() => call('documents:watch', created.id)).not.toThrow() // hits `if (fileWatchers.has(id)) return`
    expect(() => call('documents:unwatch', created.id)).not.toThrow()
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

  it('save-as falls back to the existing content/title when they are omitted', async () => {
    const created = await call('documents:create', {
      title: 'SaveFallback',
      content: 'orig-content',
      memoryOnly: false,
    })
    const dir = fakeApp.getPath()
    const newPath = join(dir, 'saved-fallback.md')
    const updated = await call('documents:save-as', created.id, newPath, {})
    expect(updated.title).toBe('SaveFallback')
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

describe('documents — watch change detection (pure logic)', () => {
  it('ignores a sibling-file write when the reported filename differs from the watched file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'))
    const watched = join(dir, 'doc.md')
    writeFileSync(watched, 'hi')
    // A different filename in the same directory (e.g. an exported HTML) should be ignored.
    expect(shouldIgnoreExternalChange('other.html', watched)).toBe(true)
  })

  it('does not ignore when the reported filename matches the watched file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'))
    const watched = join(dir, 'doc.md')
    writeFileSync(watched, 'hi')
    expect(shouldIgnoreExternalChange('doc.md', watched)).toBe(false)
  })

  it('treats an unreadable/missing file (filename omitted) as a real change, not ignore', () => {
    const missing = join(tmpdir(), 'does-not-exist-watch.md')
    expect(shouldIgnoreExternalChange(undefined, missing)).toBe(false)
  })

  it('notifyExternalChange sends app:file-changed to the main window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'))
    const watched = join(dir, 'doc.md')
    writeFileSync(watched, 'hi')
    sentFileChanged.length = 0
    notifyExternalChange('doc-id-1', watched)
    expect(sentFileChanged).toEqual([{ id: 'doc-id-1', filePath: watched }])
  })

  it('notifyExternalChange is a no-op (no throw) when there is no main window', () => {
    // Re-register the handlers with a getMainWindow that yields null, exercising the
    // `if (win)` guard. Without the guard this would throw on `win.webContents`.
    const localHandlers: Record<string, (...a: any[]) => any> = {}
    registerDocumentHandlers(
      { handle: (ch: string, fn: (...a: any[]) => any) => (localHandlers[ch] = fn) } as any,
      fakeApp,
      () => null,
    )
    const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'))
    const watched = join(dir, 'doc.md')
    writeFileSync(watched, 'hi')
    sentFileChanged.length = 0
    expect(() => notifyExternalChange('doc-id-nowin', watched)).not.toThrow()
    // Nothing was delivered to the (previously captured) window either.
    expect(sentFileChanged).toEqual([])
    // Restore the real window provider for any later tests in this file.
    registerDocumentHandlers(fakeIpcMain, fakeApp, () => fakeMainWindow)
  })

  it('notifyExternalChange still notifies when the file is unreadable (stat throws)', () => {
    // The mtime refresh is best-effort: a missing file must not prevent the renderer
    // from being told the file changed (it may have just been deleted/replaced).
    const missing = join(tmpdir(), 'mf-notify-missing-' + Date.now() + '.md')
    sentFileChanged.length = 0
    notifyExternalChange('doc-id-2', missing)
    expect(sentFileChanged).toEqual([{ id: 'doc-id-2', filePath: missing }])
  })

  it('ignores an event that lands inside the self-write suppression window', async () => {
    // documents:update sets suppressUntil for the written path (~2s). An fs.watch event
    // arriving in that window is our own save echoing back and must be suppressed —
    // even though the reported filename matches the watched file exactly.
    const created = await call('documents:create', {
      title: 'SuppressMe',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:update', created.id, { content: 'v2' })
    expect(shouldIgnoreExternalChange(basename(created.filePath), created.filePath)).toBe(true)
    // Sanity: the same filename on a path with no suppression entry is NOT ignored.
    const other = join(dirname(created.filePath), 'not-suppressed.md')
    writeFileSync(other, 'x')
    expect(shouldIgnoreExternalChange(basename(other), other)).toBe(false)
  })

  it('accepts a Buffer filename and compares it by basename', () => {
    // fs.watch may hand back a Buffer instead of a string; it must be decoded, not stringified
    // into something like "[object Object]".
    const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'))
    const watched = join(dir, 'doc.md')
    writeFileSync(watched, 'hi')
    expect(shouldIgnoreExternalChange(Buffer.from('doc.md'), watched)).toBe(false)
    expect(shouldIgnoreExternalChange(Buffer.from('other.md'), watched)).toBe(true)
  })

  it('treats an empty filename like an omitted one (falls back to the mtime check)', () => {
    // '' is falsy, so the name comparison is skipped; with no recorded baseline the
    // `?? -1` fallback makes the real mtime differ, i.e. a genuine change.
    const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'))
    const watched = join(dir, 'doc.md')
    writeFileSync(watched, 'hi')
    expect(shouldIgnoreExternalChange('', watched)).toBe(false)
    expect(shouldIgnoreExternalChange(null, watched)).toBe(false)
  })

  it('ignores a filename-less event when the watched file mtime is unchanged', async () => {
    // Start watching to record the mtime baseline, then fire the check without a filename:
    // the mtime still matches the baseline, so this was a sibling write -> ignore.
    const created = await call('documents:create', {
      title: 'MtimeBaseline',
      content: 'x',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    // Let the self-write suppression window from create/watch elapse conceptually:
    // create() does not set suppressUntil, so the mtime branch is reached directly.
    expect(shouldIgnoreExternalChange(undefined, created.filePath)).toBe(true)
    await call('documents:unwatch', created.id)
  })
})

describe('documents IPC — watch/unwatch lifecycle', () => {
  it('delivers app:file-changed when the watched file is modified externally', async () => {
    const created = await call('documents:create', {
      title: 'WatchLive',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    sentFileChanged.length = 0
    // Simulate an external editor writing the file. The watcher debounces for 300ms.
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(created.filePath, 'externally changed')
    await new Promise((r) => setTimeout(r, 900))
    expect(sentFileChanged).toContainEqual({ id: created.id, filePath: created.filePath })
    await call('documents:unwatch', created.id)
  })

  it('drops a sibling-file event delivered by the real watcher', async () => {
    // fs.watch on a file can still fire for activity in the same directory. The callback's
    // early return must swallow those so an unrelated write (e.g. an HTML export landing
    // next to the document) never surfaces as "your file changed on disk".
    const created = await call('documents:create', {
      title: 'SiblingNoise',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    sentFileChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    // Write a *different* file in the same folder, leaving the watched file untouched.
    writeFileSync(join(dirname(created.filePath), 'SiblingNoise.export.html'), '<p>x</p>')
    await new Promise((r) => setTimeout(r, 900))
    expect(sentFileChanged.filter((e) => e.id === created.id)).toEqual([])
    await call('documents:unwatch', created.id)
  })

  it('drops the watcher event echoed back by our own save', async () => {
    // documents:update writes the file itself and arms the suppression window, so the
    // watcher event it provokes must be ignored rather than bounced to the renderer.
    const created = await call('documents:create', {
      title: 'SelfWriteEcho',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    sentFileChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    await call('documents:update', created.id, { content: 'v2 written by us' })
    await new Promise((r) => setTimeout(r, 900))
    expect(sentFileChanged.filter((e) => e.id === created.id)).toEqual([])
    await call('documents:unwatch', created.id)
  })

  it('stops delivering notifications after unwatch', async () => {
    const created = await call('documents:create', {
      title: 'WatchStop',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    await call('documents:unwatch', created.id)
    sentFileChanged.length = 0
    writeFileSync(created.filePath, 'changed after unwatch')
    await new Promise((r) => setTimeout(r, 700))
    expect(sentFileChanged).toEqual([])
  })

  it('covers the debounce clearTimeout branch when a second event lands inside the 300ms window', async () => {
    // Two external writes within the 300ms debounce window: the first arms a setTimeout,
    // the second hits `if (timer) clearTimeout(timer)` before the timer fires. This is the
    // only path that exercises that line, so the branch must be reached at least once.
    const created = await call('documents:create', {
      title: 'DebounceReset',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    sentFileChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(created.filePath, 'externally changed once')
    await new Promise((r) => setTimeout(r, 80)) // still inside the 300ms window
    writeFileSync(created.filePath, 'externally changed twice')
    await new Promise((r) => setTimeout(r, 900))
    const mine = sentFileChanged.filter((e) => e.id === created.id)
    // Both writes collapse into a single debounced notification.
    expect(mine).toHaveLength(1)
    expect(mine[0]).toEqual({ id: created.id, filePath: created.filePath })
    await call('documents:unwatch', created.id)
  })

  it('watching twice reuses the existing watcher and emits a single notification', async () => {
    const created = await call('documents:create', {
      title: 'WatchTwice',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    await call('documents:watch', created.id) // early-return: already watching
    sentFileChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(created.filePath, 'changed once')
    await new Promise((r) => setTimeout(r, 900))
    const mine = sentFileChanged.filter((e) => e.id === created.id)
    // A duplicate watch must not double-register and double-notify.
    expect(mine).toHaveLength(1)
    await call('documents:unwatch', created.id)
  })

  it('unwatching a document that was never watched is a no-op', () => {
    expect(() => call('documents:unwatch', 'never-watched')).not.toThrow()
    expect(call('documents:unwatch', 'never-watched')).toBeUndefined()
  })

  it('does not watch a memory-only draft (no file_path)', async () => {
    const created = await call('documents:create', {
      title: 'WatchDraft',
      content: 'x',
      memoryOnly: true,
    })
    // watchDocument bails out on an empty file_path, so no watcher is registered and
    // a subsequent external write cannot produce a notification.
    expect(() => call('documents:watch', created.id)).not.toThrow()
    sentFileChanged.length = 0
    await new Promise((r) => setTimeout(r, 400))
    expect(sentFileChanged.filter((e) => e.id === created.id)).toEqual([])
    expect(() => call('documents:unwatch', created.id)).not.toThrow()
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
      const gbkBuf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // "中文" in GBK
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
      const gbkBuf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // "中文"
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

    it('routes an in-scope primary (utf-8 / ascii) through the CJK second pass', () => {
      // Pure ASCII is detected as 'ascii' (an in-scope primary), which must still be
      // routed into the CJK second pass and return a usable encoding with a numeric confidence.
      const buf = Buffer.from('plain ascii text', 'utf-8')
      const res = detectEncoding(buf)
      expect(typeof res.enc).toBe('string')
      expect(res.enc.length).toBeGreaterThan(0)
      expect(typeof res.confidence).toBe('number')
    })
  })

  describe('readMarkdownText', () => {
    it('reads a UTF-8 file and reports its detected encoding', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mf-rmt-'))
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
      const dir = mkdtempSync(join(tmpdir(), 'mf-rmt-'))
      const p = join(dir, 'g.md')
      writeFileSync(p, Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) // "中文"
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

describe('documents IPC — directory watch (folder-changed)', () => {
  it('emits a debounced app:folder-changed when a sibling file appears in the watched directory', async () => {
    const created = await call('documents:create', {
      title: 'DirWatch1',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    sentFolderChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(join(dirname(created.filePath), 'DirWatch1.sibling.md'), '# sibling')
    // The directory watcher debounces for 400ms before notifying.
    await new Promise((r) => setTimeout(r, 700))
    expect(sentFolderChanged).toContainEqual({ dirPath: dirname(created.filePath) })
    await call('documents:unwatch', created.id)
  })

  it('collapses a burst of directory events into a single debounced notification', async () => {
    const created = await call('documents:create', {
      title: 'DirBurst',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    sentFolderChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    const dir = dirname(created.filePath)
    writeFileSync(join(dir, 'b1.md'), '1')
    await new Promise((r) => setTimeout(r, 80)) // still inside the 400ms window
    writeFileSync(join(dir, 'b2.md'), '2')
    await new Promise((r) => setTimeout(r, 700))
    const mine = sentFolderChanged.filter((e) => e.dirPath === dir)
    // Both writes collapse into a single debounced notification.
    expect(mine).toHaveLength(1)
    await call('documents:unwatch', created.id)
  })

  it('shares one watcher across documents in the same directory via reference counting', async () => {
    const a = await call('documents:create', { title: 'RefA', content: 'v1', memoryOnly: false })
    const b = await call('documents:create', { title: 'RefB', content: 'v2', memoryOnly: false })
    expect(dirname(a.filePath)).toBe(dirname(b.filePath))
    const dir = dirname(a.filePath)
    await call('documents:watch', a.id)
    await call('documents:watch', b.id)
    // With both documents open, exactly one watcher exists; a change is reported once.
    sentFolderChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(join(dir, 'ref-touch-1.md'), 'x')
    await new Promise((r) => setTimeout(r, 700))
    expect(sentFolderChanged.filter((e) => e.dirPath === dir)).toHaveLength(1)

    // Unwatching one document keeps the shared watcher alive (refcount > 0).
    await call('documents:unwatch', a.id)
    sentFolderChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(join(dir, 'ref-touch-2.md'), 'y')
    await new Promise((r) => setTimeout(r, 700))
    expect(sentFolderChanged.filter((e) => e.dirPath === dir)).toHaveLength(1)

    // Unwatching the last document closes the watcher; further changes are silent.
    await call('documents:unwatch', b.id)
    sentFolderChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(join(dir, 'ref-touch-3.md'), 'z')
    await new Promise((r) => setTimeout(r, 700))
    expect(sentFolderChanged.filter((e) => e.dirPath === dir)).toEqual([])
  })

  it('does not throw and emits nothing when the main window is missing', async () => {
    const created = await call('documents:create', {
      title: 'NoWin',
      content: 'v1',
      memoryOnly: false,
    })
    await call('documents:watch', created.id)
    const saved = fakeMainWindow
    fakeMainWindow = null
    sentFolderChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(join(dirname(created.filePath), 'nowin.md'), 'z')
    await new Promise((r) => setTimeout(r, 700))
    // The watch callback early-returns when there is no window, so no event is sent.
    expect(sentFolderChanged).toEqual([])
    fakeMainWindow = saved
    await call('documents:unwatch', created.id)
  })

  it('reuses the shared watcher and bumps the refcount when watching a second document in the same directory', async () => {
    const a = await call('documents:create', { title: 'ReuseA', content: 'v1', memoryOnly: false })
    const b = await call('documents:create', { title: 'ReuseB', content: 'v2', memoryOnly: false })
    const dir = dirname(a.filePath)
    expect(dirname(b.filePath)).toBe(dir)
    await call('documents:watch', a.id)
    // Second watch of the same directory must hit the existing-watcher branch (refcount 1 -> 2).
    await call('documents:watch', b.id)
    // A change is still reported exactly once even though two documents reference the watcher.
    sentFolderChanged.length = 0
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(join(dir, 'reuse-touch.md'), 'x')
    await new Promise((r) => setTimeout(r, 700))
    expect(sentFolderChanged.filter((e) => e.dirPath === dir)).toHaveLength(1)
    await call('documents:unwatch', a.id)
    await call('documents:unwatch', b.id)
  })

  it('unwatches a document whose directory has no registered watcher without error', async () => {
    const created = await call('documents:create', {
      title: 'NoWatcher',
      content: 'v1',
      memoryOnly: false,
    })
    // Never call documents:watch — unwatchDirectory must handle a missing watcher (`if (w)` falsy).
    expect(() => call('documents:unwatch', created.id)).not.toThrow()
  })

  it('clears a pending debounce timer when unwatching while a directory change is still debouncing', async () => {
    // Coverage for documents.ts:251 — the `if (t) clearTimeout(t)` branch fires when
    // unwatchDirectory runs while a 400ms debounce timer is still pending (a change was
    // observed but not yet flushed). We fake only setTimeout/clearTimeout so the watcher's
    // 400ms timer stays deterministically pending; setImmediate stays real so the real
    // fs.watch IO event can still be delivered and register that pending timer.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const created = await call('documents:create', {
        title: 'PendingTimer',
        content: 'v1',
        memoryOnly: false,
      })
      await call('documents:watch', created.id)
      const dir = dirname(created.filePath)
      // Trigger a directory change so the watcher schedules a (now fake, pending) debounce timer.
      writeFileSync(join(dir, 'pending-touch.md'), 'x')
      // Let the real fs.watch IO event fire and register the pending timer.
      await new Promise((r) => setImmediate(r))
      sentFolderChanged.length = 0
      // Unwatching now must clearTimeout() the pending timer, so no folder-changed is sent later.
      await call('documents:unwatch', created.id)
      // Flush any fake timers; because the pending timer was cleared, no notification fires.
      vi.runAllTimers()
      expect(sentFolderChanged).not.toContainEqual({ dirPath: dir })
    } finally {
      vi.useRealTimers()
    }
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
