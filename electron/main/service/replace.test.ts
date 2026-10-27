// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, symlinkSync } from 'node:fs'
import { createDocumentStore, upsertDocument, type Document } from '../model/documentStore'
import {
  setWorkspaceRoot,
  getWorkspaceRoot,
  __resetWorkspaceRootForTests,
} from '../model/workspaceRoot'
import { createMemoryDiskIO, type MemoryDiskIO } from '../lib/disk-io'
import { mkTestDir } from '../test-support/tmp'
import {
  planReplace,
  applyReplace,
  cancelReplace,
  undoLastReplace,
  __resetReplaceForTests,
  MAX_REPLACE_FILES,
  MAX_REPLACE_FILE_BYTES,
  MAX_REPLACE_COUNT,
  type ReplaceDeps,
} from './replace'
import type { ReplaceApplyOptions } from '../../../shared/searchTypes'

let io: MemoryDiskIO = createMemoryDiskIO()
let root: string
let session: number
const markOwnWrite = vi.fn()
const applyToStore = vi.fn()

function doc(p: Partial<Document> & { id: string; title: string; content: string }): Document {
  return {
    folderPath: '',
    filePath: '',
    wordCount: 0,
    encoding: 'utf-8',
    encodingConfidence: 1,
    createdAt: 0,
    updatedAt: 0,
    ...p,
  }
}

// Seed a document AND its bytes on the fake disk 锟?the replace pipeline reads the file, not the
// store, so a store-only document would be reported as `missing-file`.
function seed(id: string, rel: string, content: string, encoding = 'utf-8'): Document {
  const filePath = join(root, rel)
  io.writeFile(filePath, Buffer.from(content, 'utf-8'))
  const d = doc({ id, title: rel, content, filePath, encoding })
  upsertDocument(d)
  return d
}

const deps: ReplaceDeps = {
  io,
  getDocuments: () => documents,
  // Read the real module state, so a test that re-roots via `setWorkspaceRoot` is actually
  // re-rooting (a captured local variable would silently keep answering the old root).
  getRoot: () => getWorkspaceRoot(),
  getSession: () => session,
  markOwnWrite,
  applyToStore,
}

beforeEach(() => {
  __resetReplaceForTests()
  __resetWorkspaceRootForTests()
  createDocumentStore()
  io = createMemoryDiskIO()
  deps.io = io
  deps.getDocuments = () => documents
  root = mkTestDir('replace-')
  session = 1
  setWorkspaceRoot(root)
  markOwnWrite.mockClear()
  applyToStore.mockClear()
})

let documents: Document[] = []
function setDocs(...docs: Document[]) {
  documents = docs
}

const base = { unsavedDocumentIds: [] as string[], documentStateRevision: 7 }

describe('replace 锟?planning', () => {
  it('counts every occurrence across files', async () => {
    setDocs(seed('a', 'a.md', 'cat and cat'), seed('b', 'sub/b.md', 'cat'))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(2)
    expect(outcome.plan.matchCount).toBe(3)
  })

  it('skips memory-only drafts, unsaved files and files with no hit 锟?and says why', async () => {
    setDocs(
      seed('a', 'a.md', 'cat'),
      seed('b', 'b.md', 'nothing here'),
      seed('c', 'c.md', 'cat'),
      doc({ id: 'draft', title: 'draft', content: 'cat', memoryOnly: true }),
    )
    const outcome = await planReplace(
      {
        query: 'cat',
        replaceText: 'dog',
        unsavedDocumentIds: ['c'],
        documentStateRevision: 7,
        cancelToken: 't1',
      },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(1)
    const reasons = outcome.plan.skipped.map((s) => s.reason)
    expect(reasons).toContain('memory-only')
    expect(reasons).toContain('unsaved')
    expect(reasons).toContain('no-hit')
  })

  it('honours the scope', async () => {
    // `path-not-found` is checked against the filesystem, so the directories have to exist.
    io.mkdir(join(root, 'docs'), { recursive: true })
    io.mkdir(join(root, 'archive'), { recursive: true })
    setDocs(seed('a', 'docs/a.md', 'cat'), seed('b', 'archive/b.md', 'cat'))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', include: './docs', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(1)
  })

  it('fails closed on an invalid pattern', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', include: 'a[bc', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-pattern' })
  })

  it('refuses without a workspace root', async () => {
    setWorkspaceRoot(null)
    setDocs(seed('a', 'a.md', 'cat'))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'no-workspace-root' })
  })

  it('replaces only the clicked occurrence for "Replace Here"', async () => {
    setDocs(seed('a', 'a.md', 'cat cat cat'))
    const outcome = await planReplace(
      {
        query: 'cat',
        replaceText: 'dog',
        target: { documentId: 'a', matchStartUtf16: 4 },
        ...base,
        cancelToken: 't1',
      },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.matchCount).toBe(1)
  })
})

describe('replace 锟?safety budget (ADR-0023)', () => {
  it('writes NOTHING and names the offenders when the file budget trips', async () => {
    const docs: Document[] = []
    // One more file than the budget allows: the check must fire BEFORE any I/O.
    for (let i = 0; i < MAX_REPLACE_FILES + 1; i++) {
      docs.push(seed(`f${i}`, `f${i}.md`, 'cat'))
    }
    setDocs(...docs)
    const before = io.readFile(join(root, 'f0.md')).toString()
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('aborted')
    expect(outcome.aborted?.limit).toBe('files')
    expect(outcome.aborted?.offending.length).toBeGreaterThan(0)
    // Zero writes: the whole point of tripping the budget before scanning.
    expect(io.readFile(join(root, 'f0.md')).toString()).toBe(before)
  })
})

describe('replace 锟?cancellation (ADR-0023)', () => {
  it('stops a running plan and writes nothing', async () => {
    const docs: Document[] = []
    for (let i = 0; i < 200; i++) docs.push(seed(`c${i}`, `c${i}.md`, 'cat'))
    setDocs(...docs)
    const before = io.readFile(join(root, 'c0.md')).toString()

    const running = planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 'tok' },
      deps,
    )
    const cancelled = cancelReplace('tok')
    const outcome = await running

    expect(cancelled).toBe(true)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('cancelled')
    expect(io.readFile(join(root, 'c0.md')).toString()).toBe(before)
  })

  it('returns false for an unknown token', () => {
    expect(cancelReplace('nope')).toBe(false)
  })
})

describe('replace 锟?applying', () => {
  async function planned(extra: Record<string, unknown> = {}) {
    return planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1', ...extra },
      deps,
    )
  }

  it('writes the replacement and keeps encoding details', async () => {
    setDocs(seed('a', 'a.md', 'cat\ncat'))
    const p = await planned()
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const res = await applyReplace({ planId: p.plan.planId, ...base }, deps)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.replaced).toBe(2)
    expect(io.readFile(join(root, 'a.md')).toString('utf-8')).toBe('dog\ndog')
    // No watcher echo: our own write must be suppressed.
    expect(markOwnWrite).toHaveBeenCalledWith(join(root, 'a.md'))
    expect(applyToStore).toHaveBeenCalledWith('a', 'dog\ndog')
  })

  it('preserves a BOM and CRLF line endings', async () => {
    const filePath = join(root, 'bom.md')
    io.writeFile(
      filePath,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('cat\r\ncat', 'utf-8')]),
    )
    setDocs(doc({ id: 'bom', title: 'bom', content: 'cat\r\ncat', filePath }))
    const p = await planned()
    if (!p.ok) throw new Error('plan failed')
    await applyReplace({ planId: p.plan.planId, ...base }, deps)
    const out = io.readFile(filePath)
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(out.subarray(3).toString('utf-8')).toBe('dog\r\ndog')
  })

  it('refuses to replay a plan (single-use planId)', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    const p = await planned()
    if (!p.ok) throw new Error('plan failed')
    await applyReplace({ planId: p.plan.planId, ...base }, deps)
    const second = await applyReplace({ planId: p.plan.planId, ...base }, deps)
    expect(second).toMatchObject({ ok: false, reason: 'stale-plan' })
  })

  it('writes nothing when the dirty-state revision moved on', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    const p = await planned()
    if (!p.ok) throw new Error('plan failed')
    const before = io.readFile(join(root, 'a.md')).toString()
    const res = await applyReplace(
      { planId: p.plan.planId, unsavedDocumentIds: [], documentStateRevision: 99 },
      deps,
    )
    expect(res).toMatchObject({ ok: false, reason: 'revision-mismatch' })
    expect(io.readFile(join(root, 'a.md')).toString()).toBe(before)
  })

  it('reports a conflict instead of clobbering an external change', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    const p = await planned()
    if (!p.ok) throw new Error('plan failed')
    io.writeFile(join(root, 'a.md'), Buffer.from('edited outside', 'utf-8'))
    const res = await applyReplace({ planId: p.plan.planId, ...base }, deps)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files[0]).toMatchObject({ status: 'conflict', reason: 'external-change' })
    expect(io.readFile(join(root, 'a.md')).toString()).toBe('edited outside')
  })

  it('skips a file that became unsaved between plan and apply', async () => {
    setDocs(seed('a', 'a.md', 'cat'), seed('b', 'b.md', 'cat'))
    const p = await planned()
    if (!p.ok) throw new Error('plan failed')
    const res = await applyReplace(
      {
        planId: p.plan.planId,
        unsavedDocumentIds: ['a'],
        documentStateRevision: 7,
      },
      deps,
    )
    // Deliberately a hard stop: `a` was part of the confirmed count, so applying "the rest" would
    // silently do something other than what the user confirmed.
    expect(res).toMatchObject({ ok: false, reason: 'revision-mismatch' })
  })
})

describe('replace 锟?undo', () => {
  it('restores what the last apply wrote', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    const p = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    if (!p.ok) throw new Error('plan failed')
    await applyReplace({ planId: p.plan.planId, ...base }, deps)
    expect(io.readFile(join(root, 'a.md')).toString()).toBe('dog')

    const undo = await undoLastReplace(deps)
    expect(undo.ok).toBe(true)
    expect(undo.restored).toBe(1)
    expect(io.readFile(join(root, 'a.md')).toString()).toBe('cat')
  })

  it('reports nothing to undo before any replace', async () => {
    expect(await undoLastReplace(deps)).toMatchObject({ ok: false, reason: 'no-transaction' })
  })

  it('refuses to undo across a workspace change', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    const p = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    if (!p.ok) throw new Error('plan failed')
    await applyReplace({ planId: p.plan.planId, ...base }, deps)
    session = 2
    expect(await undoLastReplace(deps)).toMatchObject({ ok: false, reason: 'workspace-changed' })
  })
})

// 鈹€鈹€鈹€ Planning: rejection and skip reasons 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe('replace 鈥?defensive payload guards', () => {
  // The IPC layer already validates its input, so these guards are reached only by a caller that
  // bypasses it. They exist because "no query" must never be read as "match everything".
  it('treats a missing options object as an empty query', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    expect(
      await planReplace(undefined as unknown as Parameters<typeof planReplace>[0], deps),
    ).toMatchObject({ ok: false, reason: 'empty-query' })
  })

  it('treats a missing query as an empty query', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    expect(
      await planReplace(
        {
          replaceText: 'dog',
          ...base,
          cancelToken: 't1',
        } as unknown as Parameters<typeof planReplace>[0],
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'empty-query' })
  })

  it('treats a missing planId as a stale plan', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    const res = await applyReplace(
      { unsavedDocumentIds: [], documentStateRevision: 7 } as unknown as Parameters<
        typeof applyReplace
      >[0],
      deps,
    )
    expect(res).toMatchObject({ ok: false, reason: 'stale-plan' })
  })

  it('falls back to utf-8 when a document carries no encoding', async () => {
    // `doc.encoding` is typed as required, so the `||` fallback is reachable only through a store
    // row that predates the field 鈥?exactly what a hand-edited store or a migration produces.
    const filePath = join(root, 'legacy.md')
    io.writeFile(filePath, Buffer.from('cat', 'utf-8'))
    const legacy = doc({ id: 'legacy', title: 'legacy.md', content: 'cat', filePath })
    delete (legacy as { encoding?: string }).encoding
    setDocs(legacy)
    const p = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    if (!p.ok) throw new Error('plan failed')
    expect(p.plan.fileCount).toBe(1)
  })
})

describe('replace 锟?planning rejections and skip reasons', () => {
  it('rejects an empty query before touching the store', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    expect(
      await planReplace({ query: '', replaceText: 'dog', ...base, cancelToken: 't1' }, deps),
    ).toMatchObject({ ok: false, reason: 'empty-query' })
  })

  it('rejects a non-string replacement', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    expect(
      await planReplace(
        {
          query: 'cat',
          replaceText: undefined as unknown as string,
          ...base,
          cancelToken: 't1',
        },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'empty-query' })
  })

  it('requires the dirty-state payload to be an array and a number', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    expect(
      await planReplace(
        {
          query: 'cat',
          replaceText: 'dog',
          documentStateRevision: 7,
          cancelToken: 't1',
        } as unknown as Parameters<typeof planReplace>[0],
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'missing-dirty-state' })
    expect(
      await planReplace(
        {
          query: 'cat',
          replaceText: 'dog',
          unsavedDocumentIds: [],
          documentStateRevision: 'x' as unknown as number,
          cancelToken: 't1',
        },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'missing-dirty-state' })
  })

  it('requires a cancel token 锟?without one the plan cannot be cancelled at all', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    expect(
      await planReplace(
        {
          query: 'cat',
          replaceText: 'dog',
          unsavedDocumentIds: [],
          documentStateRevision: 7,
        } as unknown as Parameters<typeof planReplace>[0],
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'missing-dirty-state' })
  })

  it('refuses a regex that does not compile, and writes nothing (D33)', async () => {
    setDocs(seed('a', 'a.md', 'cat'))
    const outcome = await planReplace(
      { query: '(', replaceText: 'dog', regexp: true, ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('invalid-regex')
    expect(outcome.diagnostic).toMatchObject({
      code: 'invalid-regex',
      field: 'query',
      blocking: true,
    })
  })

  it('skips a document whose file lives outside the workspace root', async () => {
    const outside = mkTestDir('replace-outside-')
    setDocs(
      seed('a', 'a.md', 'cat'),
      doc({ id: 'x', title: 'x.md', content: 'cat', filePath: join(outside, 'x.md') }),
    )
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(1)
    expect(outcome.plan.skipped.map((s) => s.reason)).toContain('out-of-root')
  })

  it('skips a document with no file path even when it is not flagged memory-only', async () => {
    setDocs(seed('a', 'a.md', 'cat'), doc({ id: 'nofile', title: 'scratch', content: 'cat' }))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(1)
    expect(outcome.plan.skipped.map((s) => s.reason)).toContain('memory-only')
  })

  it('reports a missing file when the bytes are not on disk', async () => {
    setDocs(
      doc({ id: 'ghost', title: 'ghost.md', content: 'cat', filePath: join(root, 'ghost.md') }),
    )
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(0)
    expect(outcome.plan.skipped.map((s) => s.reason)).toContain('missing-file')
  })

  it('reports an unreadable file when the path is a directory', async () => {
    // `exists()` is true for a directory but `readFile()` throws 锟?the exact shape the
    // 'unreadable' skip reason exists for.
    io.mkdir(join(root, 'adir'), { recursive: true })
    setDocs(doc({ id: 'dir', title: 'adir', content: 'cat', filePath: join(root, 'adir') }))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(0)
    expect(outcome.plan.skipped.map((s) => s.reason)).toContain('unreadable')
  })

  it('reports no-hit when the "Replace Here" offset is not a real match', async () => {
    // The offset is verified against the CURRENT bytes, not a remembered index.
    setDocs(seed('a', 'a.md', 'cat cat'))
    const outcome = await planReplace(
      {
        query: 'cat',
        replaceText: 'dog',
        target: { documentId: 'a', matchStartUtf16: 1 },
        ...base,
        cancelToken: 't1',
      },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(0)
    expect(outcome.plan.skipped.map((s) => s.reason)).toContain('no-hit')
  })

  it('replaces every occurrence when "Replace Here" names only the document', async () => {
    setDocs(seed('a', 'a.md', 'cat cat'), seed('b', 'b.md', 'cat'))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', target: { documentId: 'a' }, ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(1)
    expect(outcome.plan.matchCount).toBe(2)
  })

  it('skips a file whose replacement cannot be encoded in its own encoding', async () => {
    // 'ascii' cannot round-trip '锟?, so the file is reported rather than silently degraded.
    setDocs(seed('a', 'a.md', 'cat', 'ascii'))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'x鈧瑈', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(0)
    expect(outcome.plan.skipped.map((s) => s.reason)).toContain('unreadable')
  })

  it('names the files already scanned when cancelled mid-plan', async () => {
    setDocs(seed('a', 'a.md', 'cat'), seed('b', 'b.md', 'cat'))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 'tok' },
      deps,
      (done) => {
        // Cancel once the first file is fully scanned and queued, so the cancellation report
        // carries a non-empty list of what had already been accounted for.
        if (done === 1) cancelReplace('tok')
      },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('cancelled')
    expect(outcome.aborted?.offending).toEqual(['a.md'])
    expect(outcome.aborted?.offendingTotal).toBe(1)
  })
})

// 鈹€鈹€鈹€ Every safety-budget limit aborts with zero writes (ADR-0023 D18) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe('replace 锟?one case per safety budget', () => {
  it('aborts on the per-file byte budget', async () => {
    io.writeFile(join(root, 'big.md'), Buffer.alloc(MAX_REPLACE_FILE_BYTES + 1, 0x61))
    setDocs(doc({ id: 'big', title: 'big.md', content: 'cat', filePath: join(root, 'big.md') }))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.aborted?.limit).toBe('file-bytes')
  })

  it('aborts on the total input-byte budget', async () => {
    // Four files at exactly the per-file limit stay under it individually, but the fifth pushes
    // the running total past 64 MiB.
    for (let i = 0; i < 4; i++) {
      io.writeFile(join(root, `big${i}.md`), Buffer.alloc(MAX_REPLACE_FILE_BYTES, 0x61))
    }
    io.writeFile(join(root, 'small.md'), Buffer.from('cat', 'utf-8'))
    setDocs(
      doc({ id: 'big0', title: 'big0.md', content: 'cat', filePath: join(root, 'big0.md') }),
      doc({ id: 'big1', title: 'big1.md', content: 'cat', filePath: join(root, 'big1.md') }),
      doc({ id: 'big2', title: 'big2.md', content: 'cat', filePath: join(root, 'big2.md') }),
      doc({ id: 'big3', title: 'big3.md', content: 'cat', filePath: join(root, 'big3.md') }),
      doc({ id: 'small', title: 'small.md', content: 'cat', filePath: join(root, 'small.md') }),
    )
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.aborted?.limit).toBe('input-bytes')
  })

  it('aborts on the total match-count budget', async () => {
    setDocs(seed('a', 'a.md', 'cat'.repeat(MAX_REPLACE_COUNT + 1)))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.aborted?.limit).toBe('count')
  })

  it('aborts on the total output-byte budget', async () => {
    // Output is measured on the ACTUAL buffer that would be written, so the cheapest way to blow
    // it is to inflate bytes-per-character: a UTF-16LE file with 100k hits and a 700-character
    // replacement produces 140 MB of encoded output from a 600 KB input, and it aborts on the
    // FIRST file 锟?which also keeps peak memory to a single candidate.
    const content = 'cat'.repeat(MAX_REPLACE_COUNT)
    io.writeFile(join(root, 'wide.md'), Buffer.from(content, 'utf-16le'))
    setDocs(
      doc({
        id: 'wide',
        title: 'wide.md',
        content,
        filePath: join(root, 'wide.md'),
        encoding: 'utf-16le',
      }),
    )
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'x'.repeat(700), ...base, cancelToken: 't1' },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.aborted?.limit).toBe('output-bytes')
  })
})

// 鈹€鈹€鈹€ Apply: refusal gates and per-file failures 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe('replace 锟?apply refusal gates and per-file failures', () => {
  async function planned(extra: Record<string, unknown> = {}) {
    setDocs(seed('a', 'a.md', 'cat'))
    const p = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1', ...extra },
      deps,
    )
    if (!p.ok) throw new Error('plan failed')
    return p
  }

  it('refuses to apply once the workspace session moved on', async () => {
    const p = await planned()
    session = 2
    expect(await applyReplace({ planId: p.plan.planId, ...base }, deps)).toMatchObject({
      ok: false,
      reason: 'workspace-changed',
    })
  })

  it('refuses to apply once the workspace root moved on', async () => {
    const p = await planned()
    setWorkspaceRoot(mkTestDir('replace-moved-'))
    expect(await applyReplace({ planId: p.plan.planId, ...base }, deps)).toMatchObject({
      ok: false,
      reason: 'workspace-changed',
    })
  })

  it('refuses to apply when the dirty-state payload is not trustworthy', async () => {
    const p = await planned()
    expect(
      await applyReplace(
        {
          planId: p.plan.planId,
          unsavedDocumentIds: [],
          documentStateRevision: 'x' as unknown as number,
        },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'revision-mismatch' })
    expect(
      await applyReplace(
        {
          planId: p.plan.planId,
          unsavedDocumentIds: 'a' as unknown as string[],
          documentStateRevision: 7,
        },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'revision-mismatch' })
  })

  it('refuses to apply a plan computed against a different unsaved set', async () => {
    // The gate is set equality, not a subset check: a renderer that forgot a dirty document must
    // not be allowed to apply a plan that would overwrite it. Order must not matter, so this also
    // covers the sorted comparison's positive path.
    const p = await planned()
    expect(
      await applyReplace(
        { planId: p.plan.planId, unsavedDocumentIds: ['other'], documentStateRevision: 7 },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'revision-mismatch' })
  })

  it('accepts an apply whose unsaved set matches the plan regardless of order', async () => {
    // `sameStringSet` sorts before comparing, so a reordered list is the SAME set 鈥?a renderer that
    // reordered its registry must not be told the workspace changed. This is the only path that
    // reaches the sorted comparison with a non-empty list.
    setDocs(seed('a', 'a.md', 'cat'), seed('b', 'b.md', 'cat'))
    const p = await planReplace(
      {
        query: 'cat',
        replaceText: 'dog',
        unsavedDocumentIds: ['b'],
        documentStateRevision: 7,
        cancelToken: 't1',
      },
      deps,
    )
    if (!p.ok) throw new Error('plan failed')
    const res = await applyReplace(
      { planId: p.plan.planId, unsavedDocumentIds: ['b'], documentStateRevision: 7 },
      deps,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.replaced).toBe(1)
  })

  it('treats a plan whose apply threw as spent, so it cannot be replayed', async () => {
    const p = await planned()
    // Reflect-into-store throws AFTER plan.applied was set, so the plan stays in the registry
    // marked applied and a second apply must be refused.
    applyToStore.mockImplementationOnce(() => {
      throw new Error('store blew up')
    })
    await expect(applyReplace({ planId: p.plan.planId, ...base }, deps)).rejects.toThrow(
      'store blew up',
    )
    expect(await applyReplace({ planId: p.plan.planId, ...base }, deps)).toMatchObject({
      ok: false,
      reason: 'stale-plan',
    })
  })

  it('reports a write-error when the file vanished before apply', async () => {
    const p = await planned()
    // The file disappears between plan and apply, so the write is reported rather than attempted.
    io.remove(join(root, 'a.md'))
    const res = await applyReplace({ planId: p.plan.planId, ...base }, deps)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files[0]).toMatchObject({ status: 'failed', reason: 'write-error' })
  })

  it('reports a write-error when the atomic write throws', async () => {
    const p = await planned()
    deps.io = {
      ...io,
      writeFileAtomic: () => {
        throw new Error('EIO')
      },
    }
    const res = await applyReplace({ planId: p.plan.planId, ...base }, deps)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files[0]).toMatchObject({ status: 'failed', reason: 'write-error' })
  })

  it('reports a conflict when the file changed after the plan was made', async () => {
    const p = await planned()
    io.writeFile(join(root, 'a.md'), Buffer.from('rewritten by someone else', 'utf-8'))
    const res = await applyReplace({ planId: p.plan.planId, ...base }, deps)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files[0]).toMatchObject({ status: 'conflict', reason: 'external-change' })
    expect(res.replaced).toBe(0)
  })
})

// 鈹€鈹€鈹€ Undo: skip reasons and partial restore 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe('replace 锟?undo skip reasons and partial restore', () => {
  async function applied(content = 'cat') {
    setDocs(seed('a', 'a.md', content))
    const p = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    if (!p.ok) throw new Error('plan failed')
    await applyReplace({ planId: p.plan.planId, ...base }, deps)
  }

  it('skips a file that is gone by undo time', async () => {
    await applied()
    io.remove(join(root, 'a.md'))
    expect(await undoLastReplace(deps)).toMatchObject({ ok: true, restored: 0, skipped: 1 })
  })

  it('skips a file edited after the replace by undo time', async () => {
    await applied()
    io.writeFile(join(root, 'a.md'), Buffer.from('edited afterwards', 'utf-8'))
    expect(await undoLastReplace(deps)).toMatchObject({ ok: true, restored: 0, skipped: 1 })
  })

  it('skips a file whose restore write throws', async () => {
    await applied()
    deps.io = {
      ...io,
      writeFileAtomic: () => {
        throw new Error('EIO')
      },
    }
    expect(await undoLastReplace(deps)).toMatchObject({ ok: true, restored: 0, skipped: 1 })
  })

  it('restores what it can and skips the rest (partial undo)', async () => {
    setDocs(seed('a', 'a.md', 'cat'), seed('b', 'b.md', 'cat'))
    const p = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 't1' },
      deps,
    )
    if (!p.ok) throw new Error('plan failed')
    await applyReplace({ planId: p.plan.planId, ...base }, deps)
    // b was edited after the replace, so only a is restorable.
    io.writeFile(join(root, 'b.md'), Buffer.from('edited', 'utf-8'))
    const undo = await undoLastReplace(deps)
    expect(undo).toMatchObject({ ok: true, restored: 1, skipped: 1 })
    expect(io.readFile(join(root, 'a.md')).toString()).toBe('cat')
    expect(io.readFile(join(root, 'b.md')).toString()).toBe('edited')
  })

  it('refuses to undo across a root change', async () => {
    await applied()
    setWorkspaceRoot(mkTestDir('replace-undoroot-'))
    expect(await undoLastReplace(deps)).toMatchObject({ ok: false, reason: 'workspace-changed' })
  })
})

// ─── §5.5.3: real-path containment ──────────────────────────────────────────────────────────────

describe('replace — symlink containment (§5.5.3)', () => {
  it('never plans a write through a symlink that escapes the workspace root', async () => {
    // Lexical containment cannot see through links: a link inside the root can point outside
    // it, and the write must never follow it out. The skip happens at PLAN time, so the count
    // the user confirms matches the files that would actually be written.
    //
    // A DIRECTORY link is what makes this constructible everywhere: `junction` needs no
    // SeCreateSymbolicLinkPrivilege on Windows (unlike a file symlink) and is ignored on
    // POSIX, where a plain directory symlink does the same job. A file symlink would make
    // this test silently pass-without-testing on a non-elevated Windows box.
    const outside = mkTestDir('replace-outside-')
    writeFileSync(join(outside, 'target.md'), 'outside cat', 'utf-8')
    symlinkSync(outside, join(root, 'escape'), 'junction')

    // The record points at the link (lexically inside the root); the fake disk holds its bytes.
    const linkPath = join(root, 'escape', 'target.md')
    io.writeFile(linkPath, Buffer.from('cat', 'utf-8'))
    setDocs(doc({ id: 'esc', title: 'escape/target.md', content: 'cat', filePath: linkPath }))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 'symlink' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(0)
    expect(outcome.plan.skipped).toEqual([
      { documentId: 'esc', relPath: 'escape/target.md', reason: 'out-of-root' },
    ])
  })

  it('treats an unresolvable real path as inside the root rather than failing the plan', async () => {
    // The mirror image of the guard above: realpathSync can throw (vanished file, a parent
    // directory we cannot traverse), and that must degrade to "not proven to escape" instead
    // of aborting a plan over a resolution error. Only reachable with a memory disk, where
    // the bytes exist while the real filesystem does not have the path.
    const ghost = join(root, 'vanished.md')
    io.writeFile(ghost, Buffer.from('cat', 'utf-8'))
    setDocs(doc({ id: 'van', title: 'vanished.md', content: 'cat', filePath: ghost }))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 'vanished' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(1)
  })

  it('still plans a REAL file inside the root (the check must not over-block)', async () => {
    // The other side of the containment check: a real file whose realpath IS inside the root
    // must be planned normally — a guard that skipped everything would be its own bug.
    const real = join(root, 'real.md')
    writeFileSync(real, 'cat', 'utf-8')
    setDocs(seed('real', 'real.md', 'cat'))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 'real' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(1)
    expect(outcome.plan.skipped).toEqual([])
  })

  it('falls back to lexical containment when the root itself cannot be resolved', async () => {
    // A root that does not exist on the real filesystem (memory-only fixture): realpathSync
    // throws, and the plan must degrade to the lexical check rather than fail. The document
    // is seeded by hand because `seed` builds paths from the REAL root.
    const ghost = join(root, 'ghost-root')
    setWorkspaceRoot(ghost)
    const ghostFile = join(ghost, 'g.md')
    io.writeFile(ghostFile, Buffer.from('cat', 'utf-8'))
    setDocs(doc({ id: 'g', title: 'g.md', content: 'cat', filePath: ghostFile }))
    const outcome = await planReplace(
      { query: 'cat', replaceText: 'dog', ...base, cancelToken: 'ghost' },
      deps,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fileCount).toBe(1)
    setWorkspaceRoot(root)
  })
})

// ─── D38: the confirmation gate is UI-only ─────────────────────────────────────────────────────

describe('replace — confirmation gate is UI-only (D38)', () => {
  it('ReplaceApplyOptions has no confirmationToken field', () => {
    // A main-process check for a same-origin token could only ever be a "non-empty" fake gate,
    // so the contract must never grow the field. `npm run typecheck` covers this file
    // (tsconfig.tests.json): adding the field breaks the build here. The runtime half of the
    // gate — "no apply without a confirmed plan" — is asserted by the UI tests.
    const opts: ReplaceApplyOptions = {
      planId: 'p',
      unsavedDocumentIds: [],
      documentStateRevision: 0,
      // @ts-expect-error — the field must not exist on the contract (D38)
      confirmationToken: 'x',
    }
    void opts
  })
})
