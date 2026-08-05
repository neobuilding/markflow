// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { registerDocumentHandlers, shouldIgnoreExternalChange, notifyExternalChange } from '../documents'

// In-memory fake DB standing in for better-sqlite3 (which can't load under system Node).
// Supports exactly the statements documents.ts issues, matched by substring on the SQL.
const docs = new Map<string, any>()
const fakeDb = {
  prepare(sql: string) {
    const isInsert = /INSERT INTO documents/.test(sql)
    const isUpdate = /UPDATE documents/.test(sql)
    const isDelete = /DELETE FROM documents/.test(sql)
    const byId = /WHERE id = \?/.test(sql) && !/file_path = \?/.test(sql)
    const byPath = /WHERE file_path = \?/.test(sql)
    return {
      get(...args: any[]) {
        if (throwOnSelectById) throw new Error('simulated DB failure')
        if (byPath) return docs.get(`path:${args[0]}`) ?? undefined
        const id = args[0]
        for (const d of docs.values()) if (d.id === id) return d
        return undefined
      },
      all(...args: any[]) {
        if (/WHERE folder_path = \?/.test(sql)) {
          return [...docs.values()].filter((d) => d.folder_path === args[0] && !d.is_archived)
        }
        return [...docs.values()].filter((d) => !d.is_archived)
      },
      run(...args: any[]) {
        if (isInsert) {
          // Pair each `?` in the VALUES clause with the matching column name, skipping
          // inline literal values (e.g. the `0` for is_archived that is not a placeholder).
          const colPart = [...sql.matchAll(/INSERT INTO documents\s*\(([^)]+)\)/gi)][0]?.[1] ?? ''
          const cols = colPart.split(',').map((c) => c.trim())
          const valPart = [...sql.matchAll(/VALUES\s*\(([^)]+)\)/gi)][0]?.[1] ?? ''
          const valTokens = valPart.split(',').map((v) => v.trim())
          const row: any = { is_archived: 0, encoding: 'utf-8', encoding_confidence: 1 }
          let argIdx = 0
          cols.forEach((c, i) => {
            if (valTokens[i] === '?') {
              row[c] = args[argIdx++]
            }
          })
          docs.set(row.id, row)
          if (row.file_path) docs.set(`path:${row.file_path}`, row)
          return { lastInsertRowid: row.id }
        }
        if (isUpdate) {
          // Parse the SET columns so we assign args by NAME regardless of column order.
          const setCols = [...sql.matchAll(/SET\s+([^;]+?)\s+WHERE/gi)][0]?.[1] ?? ''
          const cols = [...setCols.matchAll(/(\w+)\s*=\s*\?/g)].map((m) => m[1])
          // The trailing arg is the id (WHERE id = ?)
          const id = args[args.length - 1]
          const values = args.slice(0, args.length - 1)
          const d = [...docs.values()].find((x) => x.id === id)
          if (d) {
            cols.forEach((c, i) => {
              d[c] = values[i]
            })
            if (d.file_path) docs.set(`path:${d.file_path}`, d)
          }
          return { changes: d ? 1 : 0 }
        }
        if (isDelete) {
          const id = args[0]
          for (const [k, d] of docs) {
            if (d.id === id) {
              docs.delete(k)
              if (d.file_path) docs.delete(`path:${d.file_path}`)
            }
          }
          return { changes: 1 }
        }
        return {}
      },
    }
  },
  transaction<T extends (...a: any[]) => any>(fn: T): T {
    return ((...a: any[]) => fn(...a)) as T
  },
}
vi.mock('../../db/database', () => ({ getDb: () => fakeDb }))

// When true, the fake DB's SELECT-by-id get() throws, exercising the defensive
// catch block in watchDocument (the DB read failing should not crash watching).
let throwOnSelectById = false

// app:getInitialPaths etc. not used by documents handlers; also need app for getPath.
const handlers: Record<string, (...a: any[]) => any> = {}
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: any[]) => any) => {
    handlers[ch] = fn
  },
} as any
// A stable temp dir for the whole test file, so collision-retry tests can pre-create files
// in the exact directory the create/update handlers will write into.
const stableDocsRoot = mkdtempSync(join(tmpdir(), 'mf-db-'))
const fakeApp = { getPath: () => stableDocsRoot } as any

// A fake main window that captures 'app:file-changed' notifications, so the
// notifyExternalChange path can be exercised end-to-end.
const sentFileChanged: Array<{ id: string; filePath: string }> = []
const fakeMainWindow = {
  webContents: { send: (channel: string, payload: { id: string; filePath: string }) => {
    if (channel === 'app:file-changed') sentFileChanged.push(payload)
  } },
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
    expect(docs.get(row.id).file_path).toBe('')
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
  it('removes the DB row (and the file when present)', async () => {
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

  it('still deletes the DB row when the on-disk file unlink fails for a non-ENOENT reason', async () => {
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
    const updated = await call('documents:save-as', created.id, newPath, { title: 'S', content: 'saved' })
    expect(updated.filePath).toBe(newPath)
    expect(readFileSync(newPath, 'utf-8')).toBe('saved')
    expect(readFileSync(created.filePath, 'utf-8')).toBe('orig')
  })
})

describe('documents IPC — reload', () => {
  it('re-reads the file from disk and refreshes the DB content', async () => {
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
    for (const r of rows) expect(r.isArchived).toBe(false)
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

  it('watch swallows a DB read failure without throwing (defensive catch)', async () => {
    throwOnSelectById = true
    try {
      expect(() => call('documents:watch', 'any-id')).not.toThrow()
    } finally {
      throwOnSelectById = false
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
      folder_path: '',
      file_path: join(tmpdir(), 'does-not-exist-watch-' + id + '.md'),
      content: 'x',
      word_count: 1,
      is_archived: 0,
      encoding: 'utf-8',
      encoding_confidence: 1,
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
  it('re-opens an already-imported file, refreshing its DB record from disk', async () => {
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
  it('toDocument falls back to utf-8 when encoding/confidence are missing on the row', async () => {
    // Inject a raw row that omits encoding/encoding_confidence so toDocument's
    // `row.encoding ?? 'utf-8'` and `row.encoding_confidence ?? 1` fallbacks fire.
    const id = 'raw-' + Date.now()
    docs.set(id, {
      id,
      title: 'Raw',
      folder_path: '',
      file_path: '',
      content: 'x',
      word_count: 1,
      is_archived: 0,
      // encoding and encoding_confidence intentionally absent
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
      folder_path: '',
      file_path: srcPath,
      content: 'body',
      word_count: 1,
      is_archived: 0,
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
      folder_path: '',
      file_path: srcPath,
      content: 'encoded body',
      word_count: 1,
      is_archived: 0,
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

  it('delete of a memory-only draft only removes the DB row (no file_path to unlink)', async () => {
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
})
