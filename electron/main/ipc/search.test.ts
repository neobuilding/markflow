// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { createDocumentStore, upsertDocument, type Document } from '../model/documentStore'
import { runSearchQuery, registerSearchHandlers, handleSearchQuery } from './search'
import { setWorkspaceRoot } from '../model/workspaceRoot'
import { createMemoryDiskIO } from '../lib/disk-io'
import { mkTestDir } from '../test-support/tmp'
import type {
  SearchQueryOptions,
  SearchQueryResponse,
  SearchResult,
} from '../../../shared/searchTypes'

let io: ReturnType<typeof createMemoryDiskIO>
let root: string

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

function content(q: string, extra: Partial<Extract<SearchQueryOptions, { mode: 'content' }>> = {}) {
  return runSearchQuery(
    {
      query: q,
      mode: 'content',
      dirtyDocumentSnapshots: [],
      documentStateRevision: 0,
      ...extra,
    } as SearchQueryOptions,
    io,
  )
}

function filename(q: string) {
  return runSearchQuery({ query: q, mode: 'filename' }, io)
}

beforeEach(() => {
  createDocumentStore()
  io = createMemoryDiskIO()
  root = mkTestDir('search-')
  setWorkspaceRoot(root)
})

describe('search:query — envelope', () => {
  it('returns an empty envelope for a blank query', () => {
    const res = content('   ')
    expect(res).toEqual({
      results: [],
      diagnostics: [],
      appliedScope: { root, include: [], exclude: [] },
      truncated: false,
    })
  })

  it('reports the root it searched and echoes the parsed scope', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'needle', filePath: join(root, 'a.md') }))
    const res = content('needle', { include: './, *.md' })
    expect(res.appliedScope.root).toBe(root)
    expect(res.appliedScope.include.length).toBe(2)
  })
})

describe('search:query — content mode is literal-phrase only (D12 / D24)', () => {
  it('matches the whole phrase and not its individual words', () => {
    upsertDocument(
      doc({
        id: 'both',
        title: 'both',
        content: 'Machine Learning is here',
        filePath: join(root, 'a.md'),
      }),
    )
    upsertDocument(
      doc({
        id: 'split',
        title: 'split',
        content: 'Machine ... Learning',
        filePath: join(root, 'b.md'),
      }),
    )
    const res = content('Machine Learning')
    expect(res.results.map((r) => r.documentId)).toEqual(['both'])
  })

  it('treats a double space as a different query', () => {
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'Machine Learning', filePath: join(root, 'a.md') }),
    )
    expect(content('Machine  Learning').results).toHaveLength(0)
  })

  it('never returns a document whose only hit is in the title', () => {
    upsertDocument(
      doc({ id: '1', title: 'needle', content: 'nothing here', filePath: join(root, 'a.md') }),
    )
    expect(content('needle').results).toHaveLength(0)
  })

  it('never returns a document whose only hit is in the path', () => {
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'nothing here', filePath: join(root, 'needle.md') }),
    )
    expect(content('needle').results).toHaveLength(0)
  })

  it('is case-insensitive by default and case-sensitive with matchCase', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'Needle', filePath: join(root, 'a.md') }))
    expect(content('needle').results).toHaveLength(1)
    expect(content('needle', { matchCase: true }).results).toHaveLength(0)
    expect(content('Needle', { matchCase: true }).results).toHaveLength(1)
  })

  it('returns no results for a multi-line query (first version does not support it)', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'a\nb', filePath: join(root, 'a.md') }))
    expect(content('a\nb').results).toHaveLength(0)
  })

  it('keeps matchCount honest when matches are capped', () => {
    const body = 'x'.repeat(0) + Array.from({ length: 120 }, () => 'hit').join(' ')
    upsertDocument(doc({ id: '1', title: 'a', content: body, filePath: join(root, 'a.md') }))
    const res = content('hit')
    const r: SearchResult = res.results[0]
    expect(r.matches.length).toBe(50)
    expect(r.matchCapped).toBe(true)
    expect(r.matchCount).toBe(120)
  })

  it('orders results deterministically by root-relative path', () => {
    upsertDocument(doc({ id: 'b', title: 'b', content: 'hit', filePath: join(root, 'b.md') }))
    upsertDocument(doc({ id: 'a', title: 'a', content: 'hit', filePath: join(root, 'a.md') }))
    upsertDocument(
      doc({ id: 'n', title: 'n', content: 'hit', filePath: join(root, 'sub', 'n.md') }),
    )
    const res = content('hit')
    expect(res.results.map((r) => r.relPath)).toEqual(['a.md', 'b.md', 'sub/n.md'])
  })
})

describe('search:query — scope (D4 / D19 / D26 / D27)', () => {
  beforeEach(() => {
    upsertDocument(
      doc({ id: 'root', title: 'root', content: 'hit', filePath: join(root, 'top.md') }),
    )
    upsertDocument(
      doc({ id: 'work', title: 'work', content: 'hit', filePath: join(root, 'work', 'w.md') }),
    )
    upsertDocument(
      doc({ id: 'deep', title: 'deep', content: 'hit', filePath: join(root, 'a', 'work', 'd.md') }),
    )
    upsertDocument(doc({ id: 'draft', title: 'draft', content: 'hit', memoryOnly: true }))
    // `path-not-found` is checked against the filesystem, so the directories the path patterns
    // name have to exist in the fake for the positive cases to be reachable.
    io.mkdir(join(root, 'work'), { recursive: true })
    io.mkdir(join(root, 'a', 'work'), { recursive: true })
  })

  it('matches everything when no scope is set, drafts included', () => {
    const res = content('hit')
    expect(res.results.map((r) => r.documentId).sort()).toEqual(['deep', 'draft', 'root', 'work'])
  })

  it('`./work` hits work/** but not a/work/** (path-type patterns are anchored)', () => {
    const res = content('hit', { include: './work' })
    expect(res.results.map((r) => r.documentId)).toEqual(['work'])
  })

  it('a bare `work` hits it at any depth (ordinary glob)', () => {
    const res = content('hit', { include: 'work' })
    expect(res.results.map((r) => r.documentId).sort()).toEqual(['deep', 'work'])
  })

  it('`*.md` hits nested files (it is NOT appended `/**` blindly)', () => {
    const res = content('hit', { include: '*.md' })
    expect(res.results.map((r) => r.documentId).sort()).toEqual(['deep', 'root', 'work'])
  })

  it('exclude wins over include', () => {
    const res = content('hit', { include: '**/*.md', exclude: './a/**' })
    expect(res.results.map((r) => r.documentId).sort()).toEqual(['root', 'work'])
  })

  it('drops drafts as soon as either field is non-empty and says so', () => {
    const res = content('hit', { include: '**/*.md' })
    expect(res.results.map((r) => r.documentId)).not.toContain('draft')
    expect(res.diagnostics.some((d) => d.code === 'drafts-excluded')).toBe(true)
  })

  it('excludes drafts when only `exclude` is set (either — not both — is enough, D19)', () => {
    const res = content('hit', { exclude: 'nothing-matches-this' })
    expect(res.results.map((r) => r.documentId)).not.toContain('draft')
  })

  it('fails closed on an invalid include pattern: no results, blocking diagnostic', () => {
    const res = content('hit', { include: 'a[bc' })
    expect(res.results).toEqual([])
    const diag = res.diagnostics.find((d) => d.code === 'invalid-pattern')
    expect(diag?.blocking).toBe(true)
    expect(diag?.field).toBe('include')
    expect(diag?.pattern).toBe('a[bc')
  })

  it('fails closed on an invalid exclude pattern', () => {
    const res = content('hit', { exclude: '**/*.md}' })
    expect(res.results).toEqual([])
    expect(res.diagnostics[0]).toMatchObject({ code: 'invalid-pattern', field: 'exclude' })
  })

  it('reports a path that does not exist instead of searching the whole root', () => {
    const res = content('hit', { include: './nope' })
    expect(res.results).toEqual([])
    expect(res.diagnostics[0]).toMatchObject({ code: 'path-not-found', blocking: true })
  })

  it('does NOT split a comma inside a character class (D25)', () => {
    upsertDocument(doc({ id: 'cls', title: 'cls', content: 'hit', filePath: join(root, 'a.md') }))
    const res = content('hit', { include: '[ab,c].md' })
    // `[ab,c].md` is ONE legal character class (it matches `a.md`), so it must stay one pattern.
    // Splitting on the comma would produce `[ab` and `c].md` — both invalid — and block the query.
    expect(res.diagnostics.some((d) => d.code === 'invalid-pattern')).toBe(false)
    expect(res.results.map((r) => r.documentId)).toContain('cls')
  })

  it('blocks when a scope is set but there is no root', () => {
    setWorkspaceRoot(null)
    const res = content('hit', { include: '**/*.md' })
    expect(res.results).toEqual([])
    expect(res.diagnostics[0]).toMatchObject({ code: 'no-workspace-root', blocking: true })
  })

  it('still searches drafts with no root at all', () => {
    setWorkspaceRoot(null)
    const res = content('hit')
    expect(res.results.map((r) => r.documentId)).toEqual(['draft'])
    expect(res.appliedScope.root).toBeNull()
  })
})

describe('search:query — unsaved buffers (D28)', () => {
  it('searches the renderer buffer, not the stale on-disk text', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'old text', filePath: join(root, 'a.md') }))
    const fresh: SearchQueryResponse = content('brand new', {
      dirtyDocumentSnapshots: [{ documentId: '1', content: 'brand new text', revision: 1 }],
    })
    expect(fresh.results.map((r) => r.documentId)).toEqual(['1'])
    expect(content('old text', { dirtyDocumentSnapshots: [] }).results).toHaveLength(1)
  })

  it('rejects a content query that omits the dirty-state contract', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'x', filePath: join(root, 'a.md') }))
    expect(() =>
      runSearchQuery({ query: 'x', mode: 'content' } as unknown as SearchQueryOptions, io),
    ).toThrow(TypeError)
  })
})

describe('search:query — regex mode (D30–D36)', () => {
  it('treats the same query as a literal unless regexp is asked for', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'Hello', filePath: join(root, 'a.md') }))
    expect(content('Hel+o').results).toHaveLength(0)
    expect(content('Hel+o', { regexp: true }).results).toHaveLength(1)
  })

  it('honours Match Case and whole word together with regexp', () => {
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'Hello World', filePath: join(root, 'a.md') }),
    )
    expect(content('hello', { regexp: true }).results).toHaveLength(1)
    expect(content('hello', { regexp: true, matchCase: true }).results).toHaveLength(0)
    // `Hell\w` matches "Hello", which IS a whole word here.
    expect(content('Hell\\w', { regexp: true, wholeWord: true }).results).toHaveLength(1)
    upsertDocument(
      doc({ id: '2', title: 'b', content: 'HelloWorld', filePath: join(root, 'b.md') }),
    )
    // …but not the "Hello" inside "HelloWorld".
    expect(
      content('Hell\\w', { regexp: true, wholeWord: true }).results.map((r) => r.documentId),
    ).toEqual(['1'])
  })

  it('fails closed with a blocking invalid-regex diagnostic and clears results (D33)', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'anything', filePath: join(root, 'a.md') }))
    const res = content('(unclosed', { regexp: true })
    expect(res.results).toHaveLength(0)
    expect(res.diagnostics).toHaveLength(1)
    expect(res.diagnostics[0]).toMatchObject({
      code: 'invalid-regex',
      field: 'query',
      blocking: true,
    })
  })

  it('matches across a CRLF newline through the \\n escape and keeps original offsets (D36)', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'a\r\nb', filePath: join(root, 'a.md') }))
    const res = content('a\\nb', { regexp: true })
    expect(res.results[0].matches[0]).toMatchObject({ start: 0, end: 4, line: 1, lineSpan: 2 })
  })

  it('reports the real hit count and the display cap independently', () => {
    const body = Array.from({ length: 60 }, () => 'ab').join(' ')
    upsertDocument(doc({ id: '1', title: 'a', content: body, filePath: join(root, 'a.md') }))
    const res = content('[ab]+', { regexp: true })
    expect(res.results[0].matchCount).toBe(60)
    expect(res.results[0].matches).toHaveLength(50)
    expect(res.results[0].matchCapped).toBe(true)
    expect(res.diagnostics.map((d) => d.code)).toContain('match-cap')
  })
})

describe('search:query — regex Worker isolation (D37)', () => {
  it('does not consult the Worker at all when the query is a literal', async () => {
    // The Worker is only for backtracking regexes; a literal query is `indexOf` and must not pay
    // for a round trip — nor be able to fail because of one.
    let called = 0
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'Hello World', filePath: join(root, 'a.md') }),
    )
    const res = await handleSearchQuery(
      { query: 'Hello', mode: 'content', dirtyDocumentSnapshots: [], documentStateRevision: 0 },
      io,
      async () => {
        called += 1
        return { ok: false as const, reason: 'timeout' as const }
      },
    )
    expect(called).toBe(0)
    expect(res.results).toHaveLength(1)
  })

  it('runs the regex scan in a Worker and reports the same hits as the sync path', async () => {
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'Hello World', filePath: join(root, 'a.md') }),
    )
    const asyncRes = await handleSearchQuery(
      {
        query: 'Hel+o',
        mode: 'content',
        regexp: true,
        dirtyDocumentSnapshots: [],
        documentStateRevision: 0,
      },
      io,
    )
    // The Worker bundle does not exist under vitest, so this asserts the in-process fallback still
    // answers — the isolation must never cost correctness.
    expect(asyncRes.results).toHaveLength(1)
  })

  it('fails closed with a blocking regex-timeout diagnostic when the Worker runs out of budget', async () => {
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'Hello World', filePath: join(root, 'a.md') }),
    )
    const res = await handleSearchQuery(
      {
        query: 'Hel+o',
        mode: 'content',
        regexp: true,
        dirtyDocumentSnapshots: [],
        documentStateRevision: 0,
      },
      io,
      async () => ({ ok: false as const, reason: 'timeout' as const }),
    )
    expect(res.results).toHaveLength(0)
    expect(res.diagnostics[0]).toMatchObject({ code: 'regex-timeout', blocking: true })
  })

  it('falls back to an in-process scan when the Worker cannot be started', async () => {
    // The Worker is a mitigation, not a correctness requirement: without it the query is still
    // answered, it just runs on this thread.
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'Hello World', filePath: join(root, 'a.md') }),
    )
    const res = await handleSearchQuery(
      {
        query: 'Hel+o',
        mode: 'content',
        regexp: true,
        dirtyDocumentSnapshots: [],
        documentStateRevision: 0,
      },
      io,
      async () => ({ ok: false as const, reason: 'unavailable' as const }),
    )
    expect(res.results).toHaveLength(1)
  })

  it('uses the Worker results when it answers, in candidate order', async () => {
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'Hello World', filePath: join(root, 'a.md') }),
    )
    const res = await handleSearchQuery(
      {
        query: 'Hel+o',
        mode: 'content',
        regexp: true,
        dirtyDocumentSnapshots: [],
        documentStateRevision: 0,
      },
      io,
      async () => ({
        ok: true as const,
        results: [{ matches: [], total: 3, capped: false }],
      }),
    )
    expect(res.results[0].matchCount).toBe(3)
  })

  it('treats a short Worker reply as "no hits" rather than crashing', async () => {
    // Defensive: the reply must line up with the candidate list, but a shorter one must not throw.
    upsertDocument(
      doc({ id: '1', title: 'a', content: 'Hello World', filePath: join(root, 'a.md') }),
    )
    const res = await handleSearchQuery(
      {
        query: 'Hel+o',
        mode: 'content',
        regexp: true,
        dirtyDocumentSnapshots: [],
        documentStateRevision: 0,
      },
      io,
      async () => ({ ok: true as const, results: [] }),
    )
    expect(res.results).toHaveLength(0)
  })
})

describe('search:query — filename mode (Quick Open, D1/D9)', () => {
  it('matches titles and paths but never body text', () => {
    upsertDocument(
      doc({ id: '1', title: 'Meeting', content: 'markdown', filePath: join(root, 'meeting.md') }),
    )
    expect(filename('Meeting').results.map((r) => r.documentId)).toEqual(['1'])
    expect(filename('markdown').results).toHaveLength(0)
  })

  it('supports globs and sorts by title', () => {
    upsertDocument(doc({ id: 'a', title: 'Alpha', content: 'x', filePath: join(root, 'a.md') }))
    upsertDocument(doc({ id: 'z', title: 'Zeta', content: 'x', filePath: join(root, 'z.md') }))
    const res = filename('**/*.md')
    expect(res.results.map((r) => r.documentId)).toEqual(['a', 'z'])
    expect(res.results[0].matchCount).toBe(0)
  })

  it('exposes the absolute filePath the result menu copies', () => {
    upsertDocument(doc({ id: '1', title: 'a', content: 'x', filePath: join(root, 'a.md') }))
    const res = filename('a')
    expect(res.results[0].filePath).toBe(join(root, 'a.md'))
    expect(res.results[0].relPath).toBe('a.md')
  })
})

describe('search:query — IPC handler wiring (ADR-0023)', () => {
  it('registers the search:query channel and delegates to runSearchQuery', async () => {
    const handlers = new Map<string, (event: unknown, params: unknown) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (event: unknown, params: unknown) => unknown) =>
        handlers.set(channel, handler),
    } as unknown as import('electron').IpcMain
    registerSearchHandlers(ipcMain, io)
    expect(handlers.has('search:query')).toBe(true)

    const res = (await handlers.get('search:query')!(
      {},
      { query: 'meeting', mode: 'filename', documentStateRevision: 0, dirtyDocumentSnapshots: [] },
    )) as SearchQueryResponse
    expect(res).toHaveProperty('results')
    expect(res).toHaveProperty('appliedScope')
  })
})

describe('search:query — document cap (ADR-0023)', () => {
  it('reports a doc-cap diagnostic when more documents match than MAX_RESULT_DOCS', () => {
    for (let i = 0; i < 201; i++) {
      upsertDocument(
        doc({
          id: `cap${i}`,
          title: `f${i}.md`,
          content: 'needle here',
          filePath: join(root, `f${i}.md`),
        }),
      )
    }
    const res = content('needle')
    expect(res.diagnostics.some((d) => d.code === 'doc-cap')).toBe(true)
  })
})

describe('search:query — filename document cap', () => {
  it('reports a doc-cap diagnostic and slices to MAX_RESULT_DOCS when too many filenames match', () => {
    for (let i = 0; i < 201; i++) {
      upsertDocument(
        doc({
          id: `fn${i}`,
          title: `match${i}.md`,
          content: 'x',
          filePath: join(root, `match${i}.md`),
        }),
      )
    }
    const res = filename('match')
    expect(res.truncated).toBe(true)
    expect(res.results.length).toBeLessThanOrEqual(200)
    expect(res.diagnostics.some((d) => d.code === 'doc-cap')).toBe(true)
  })
})

describe('search:query — deterministic ordering with drafts (ADR-0023)', () => {
  it('sorts files before drafts, files by relPath, and drafts among themselves by title', () => {
    // A draft is inserted FIRST so the sort compares a file (as `a`) against a draft (as `b`),
    // exercising the `b.rel === null` branch of `compare`.
    upsertDocument(doc({ id: 'd1', title: 'Alpha', content: 'x', memoryOnly: true }))
    upsertDocument(doc({ id: 'f1', title: 'File', content: 'x', filePath: join(root, 'f.md') }))
    upsertDocument(doc({ id: 'f2', title: 'FileB', content: 'x', filePath: join(root, 'g.md') }))
    upsertDocument(doc({ id: 'd2', title: 'Zeta', content: 'x', memoryOnly: true }))
    const res = content('x')
    expect(res.results.map((r) => r.title)).toEqual(['File', 'FileB', 'Alpha', 'Zeta'])
  })
})

describe('search:query — contract edge cases', () => {
  it('returns an empty envelope when the query is missing', () => {
    const res = runSearchQuery({} as unknown as SearchQueryOptions, io)
    expect(res.results).toEqual([])
    expect(res.appliedScope).toEqual({ root, include: [], exclude: [] })
  })

  it('ignores malformed dirty snapshots (missing fields / null entries)', () => {
    upsertDocument(doc({ id: 'a', title: 'A', content: 'disk', filePath: join(root, 'a.md') }))
    const res = content('disk', {
      dirtyDocumentSnapshots: [{ documentId: 'a' } as never, null as never],
      documentStateRevision: 0,
    })
    // The malformed snapshots are skipped, so the on-disk text is searched.
    expect(res.results[0]?.matchCount).toBe(1)
  })
})
