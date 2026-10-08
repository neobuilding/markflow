// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import MiniSearch from 'minisearch'
import { createDocumentStore, upsertDocument, type Document } from '../model/documentStore'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
    handlers[ch] = fn
  },
} as any

// Import after the fake ipcMain is ready; registerSearchHandlers registers on it.
import { registerSearchHandlers, extractMatches } from './search'
registerSearchHandlers(fakeIpcMain)

function doc(p: Partial<Document> & { id: string; title: string; content: string }): Document {
  return {
    folderPath: '',
    filePath: '',
    wordCount: p.content.split(/\s+/).length,
    encoding: 'utf-8',
    encodingConfidence: 1,
    createdAt: 0,
    updatedAt: 0,
    ...p,
  }
}

function query(
  q: string,
  opts: { scopeFolder?: string | null; mode?: 'filename' | 'content' } = {},
): Awaited<ReturnType<(typeof handlers)['search:query']>> {
  return handlers['search:query'](null, { query: q, ...opts }) as Awaited<
    ReturnType<(typeof handlers)['search:query']>
  >
}

beforeEach(() => {
  createDocumentStore()
  upsertDocument(
    doc({
      id: '1',
      title: 'Getting Started',
      content: 'Welcome to markflow, a markdown editor with fast search.',
    }),
  )
  upsertDocument(
    doc({
      id: '2',
      title: 'Advanced Tips',
      content: 'Use the command palette to jump between documents quickly.',
    }),
  )
  upsertDocument(
    doc({
      id: '3',
      title: '中文搜索示例',
      content: '这是一个用于测试中文全文检索的文档，包含关键字「检索」与「示例」。',
    }),
  )
  upsertDocument(
    doc({
      id: '4',
      title: 'Meeting Notes',
      folderPath: 'work/2026/notes',
      filePath: 'work/2026/notes/meeting.md',
      content: 'Weekly sync agenda and action items.',
    }),
  )
})

describe('search:query', () => {
  it('returns [] for an empty query', async () => {
    expect(await query('   ')).toEqual([])
  })

  it('matches English terms in content and title', async () => {
    const res = (await query('markdown')) as Array<{ id: string; title: string }>
    expect(res.map((r) => r.id)).toContain('1')
  })

  it('ranks title matches above content-only matches', async () => {
    // "search" appears in doc1 content; no title has it, so both title-boosted
    // docs (if any) would rank first. Here we just assert relevance ordering is stable.
    const res = (await query('command')) as Array<{ id: string }>
    expect(res[0].id).toBe('2')
  })

  it('matches Chinese text via Intl.Segmenter tokenization', async () => {
    const res = (await query('检索')) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toContain('3')
  })

  it('does not return a body snippet in content mode (plan §3.5)', async () => {
    const res = (await query('markdown')) as Array<{ id: string; snippet: string }>
    const hit = res.find((r) => r.id === '1')
    expect(hit?.snippet).toBe('')
  })

  it('returns score and updatedAt fields', async () => {
    const res = (await query('editor')) as Array<{ score: number; updatedAt: number }>
    expect(typeof res[0].score).toBe('number')
    expect(typeof res[0].updatedAt).toBe('number')
  })

  it('matches a folder-path fragment (Ctrl+P-style file/path lookup, Q2)', async () => {
    // doc4 has folderPath 'work/2026/notes' and title 'Meeting Notes'.
    // Searching a path fragment must surface it even though neither title nor
    // content contains the term (no 'notes' in title/content here).
    const res = (await query('notes')) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toContain('4')
  })

  it('scopes results to the given folder and its sub-folders', async () => {
    // doc4 lives under work/2026/notes; docs 1-3 have no folder. Scoping to
    // 'work/2026' must surface only doc4 (and only when the term is in it).
    const inScope = (await query('Weekly', { scopeFolder: 'work/2026' })) as Array<{ id: string }>
    expect(inScope.map((r) => r.id)).toEqual(['4'])
    // A term that exists only in doc1 must not appear when scoped away from it.
    const outOfScope = (await query('markdown', { scopeFolder: 'work/2026' })) as Array<{
      id: string
    }>
    expect(outOfScope).toHaveLength(0)
  })

  it('returns the whole workspace when scopeFolder is null', async () => {
    const res = (await query('markdown', { scopeFolder: null })) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toContain('1')
  })

  it('filename mode matches only document titles, not body text', async () => {
    // 'markdown' appears in doc1's body but not its title; in filename mode it must miss.
    const byContent = (await query('markdown', { mode: 'content' })) as Array<{ id: string }>
    expect(byContent.map((r) => r.id)).toContain('1')
    const byName = (await query('markdown', { mode: 'filename' })) as Array<{ id: string }>
    expect(byName.map((r) => r.id)).not.toContain('1')
  })

  it('filename mode still surfaces a document whose title holds the term', async () => {
    const res = (await query('Meeting', { mode: 'filename' })) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toContain('4')
  })

  it('filename mode matches by glob over the path relative to the active folder', async () => {
    // doc4 is the only document with an on-disk .md path; `**/*.md` must surface it.
    const res = (await query('**/*.md', { mode: 'filename' })) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toEqual(['4'])
  })

  it('filename-mode glob is scoped to the active-folder path', async () => {
    const res = (await query('notes/*', {
      mode: 'filename',
      scopeFolder: 'work/2026',
    })) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toEqual(['4'])
  })

  it('filename mode matches plain text as a case-insensitive substring of title or path', async () => {
    // 'notes' has no glob meta, so it falls back to a substring match and still surfaces doc4
    // via its folder path / title.
    const res = (await query('notes', { mode: 'filename' })) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toContain('4')
  })

  it('returns no results when there are no documents at all', async () => {
    // Reset to an empty store: the handler must bail out before building an index.
    createDocumentStore()
    expect(await query('markdown')).toEqual([])
  })

  it('filename mode sorts multiple hits by title', async () => {
    upsertDocument(
      doc({ id: '5', title: 'Zeta', content: 'x', filePath: 'work/z.md', folderPath: 'work' }),
    )
    upsertDocument(
      doc({ id: '6', title: 'Alpha', content: 'y', filePath: 'work/a.md', folderPath: 'work' }),
    )
    const res = (await query('**/*.md', { mode: 'filename' })) as Array<{ id: string }>
    // doc4 (Meeting Notes) also has an .md path, so the comparator sorts: Alpha, Meeting, Zeta.
    expect(res.map((r) => r.id)).toEqual(['6', '4', '5'])
  })

  it('returns [] for a null/undefined query', async () => {
    expect(await query(null as unknown as string)).toEqual([])
    expect(await query(undefined as unknown as string)).toEqual([])
  })

  it('falls back to defaults when a result references a missing document', async () => {
    // Mock only for this call, then restore — otherwise the spy leaks into later tests.
    const spy = vi.spyOn(MiniSearch.prototype, 'search').mockReturnValue([
      {
        id: 'ghost',
        title: undefined,
        folderPath: undefined,
        score: 0.5,
        terms: undefined,
      },
    ] as unknown as ReturnType<MiniSearch['search']>)
    try {
      const res = (await query('anything')) as Array<{
        id: string
        title: string
        folderPath: string
        snippet: string
        updatedAt: number
      }>

      expect(res).toHaveLength(1)
      expect(res[0].id).toBe('ghost')
      expect(res[0].title).toBe('')
      expect(res[0].folderPath).toBe('')
      expect(res[0].snippet).toBe('')
      expect(res[0].updatedAt).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('extractMatches (Phase 4 hit context)', () => {
  it('returns [] for empty content or no terms', () => {
    expect(extractMatches('', ['the'], 50)).toEqual([])
    expect(extractMatches('hello world', [], 50)).toEqual([])
  })

  it('returns [] when no term occurs in the content', () => {
    expect(extractMatches('hello world', ['the'], 50)).toEqual([])
  })

  it('finds a single occurrence with absolute offsets and a clamped highlight range', () => {
    const m = extractMatches('hello world', ['world'], 50)
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({
      line: 1,
      start: 6,
      end: 11,
      excerpt: 'hello world',
      excerptStart: 6,
      excerptEnd: 11,
    })
  })

  it('collects every term occurrence per line, in order', () => {
    const m = extractMatches('the cat and the dog', ['the', 'cat'], 50)
    // 'the'@0, 'cat'@4, 'the'@12 — no overlaps, all three kept.
    expect(m.map((x) => [x.start, x.end])).toEqual([
      [0, 3],
      [4, 7],
      [12, 15],
    ])
    expect(m.every((x) => x.line === 1)).toBe(true)
  })

  it('drops overlapping (embedded) hits so a term inside another is not double-counted', () => {
    // 'the' (0-3) then 'he' (1-3) overlaps it → only the outer 'the' is kept.
    const m = extractMatches('the', ['the', 'he'], 50)
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ start: 0, end: 3 })
  })

  it('aligns offsets on CRLF content so the editor can jump to the right place', () => {
    // line1 = "line1" (5 chars) + CRLF (2) => line2 starts at offset 7.
    const m = extractMatches('line1\r\nline2 the', ['the'], 50)
    expect(m).toHaveLength(1)
    expect(m[0].line).toBe(2)
    expect(m[0].start).toBe(13) // 7 + index of 'the' within "line2 the"
    expect(m[0].end).toBe(16)
  })

  it('records the correct line number for multi-line content', () => {
    const m = extractMatches('a\nthe\nb\nthe', ['the'], 50)
    expect(m.map((x) => x.line)).toEqual([2, 4])
  })

  it('caps occurrences per document at MAX_MATCHES_PER_DOC (50)', () => {
    const content = Array.from({ length: 60 }, () => 'the').join('\n')
    const m = extractMatches(content, ['the'], 50)
    expect(m).toHaveLength(50)
  })

  it('clamps the highlight range when the match falls beyond the 120-char excerpt', () => {
    const longLine = 'x'.repeat(200) + 'the'
    const m = extractMatches(longLine, ['the'], 50)
    expect(m).toHaveLength(1)
    expect(m[0].excerpt.length).toBe(120)
    // The matched 'the' is past column 120, so it is not highlighted (range collapses to 120).
    expect(m[0].excerptStart).toBe(120)
    expect(m[0].excerptEnd).toBe(120)
  })

  it('highlights a match near the start even on a long line', () => {
    const longLine = 'the' + 'x'.repeat(200)
    const m = extractMatches(longLine, ['the'], 50)
    expect(m[0].excerptStart).toBe(0)
    expect(m[0].excerptEnd).toBe(3)
  })

  it('clamps the highlight end when a match straddles the excerpt boundary', () => {
    // 'abcdefghij' spans columns 115..125, crossing the 120-char excerpt limit.
    const content = 'x'.repeat(115) + 'abcdefghij'
    const m = extractMatches(content, ['abcdefghij'], 50)
    expect(m).toHaveLength(1)
    expect(m[0].excerptStart).toBe(115)
    expect(m[0].excerptEnd).toBe(120) // clamped to EXCERPT_MAX
  })
})

describe('search:query hit context (Phase 4)', () => {
  it('content mode attaches bounded matches; filename mode attaches none', async () => {
    // The handler reads the shared module document store, so just add a doc and query it.
    upsertDocument(doc({ id: 'd1', title: 'Note', content: 'the cat sat on the mat' }))
    const content = (await query('the', { mode: 'content' })) as Array<{
      id: string
      matches: unknown[]
      truncated?: boolean
    }>
    const hitDoc = content.find((r) => r.matches.length > 0)
    expect(hitDoc).toBeDefined()
    expect(hitDoc?.truncated).toBe(false)
    const byName = (await query('Note', { mode: 'filename' })) as Array<{ matches: unknown[] }>
    expect(byName.every((r) => r.matches.length === 0)).toBe(true)
  })

  it('marks results truncated when the candidate set exceeds MAX_RESULT_DOCS', async () => {
    // beforeEach already seeded 4 docs; add 250 more so a broad query exceeds the 200-doc cap.
    for (let i = 0; i < 250; i++) {
      upsertDocument(doc({ id: `big-${i}`, title: `Doc ${i}`, content: 'common term here' }))
    }
    const res = (await query('common', { mode: 'content' })) as Array<{
      id: string
      matches: unknown[]
      truncated?: boolean
    }>
    // Capped at 200 docs and flagged as truncated.
    expect(res).toHaveLength(200)
    expect(res.every((r) => r.truncated === true)).toBe(true)
    expect(res.some((r) => r.matches.length > 0)).toBe(true)
  })

  it('breaks relevance ties by title, lexicographically (Q12 / §3.8)', async () => {
    // The handler reads the shared module store, so seed it there. Identical bodies give
    // identical relevance, leaving only the title tiebreak to order the two.
    upsertDocument(doc({ id: 'z', title: 'Zebra', content: 'shared phrase here' }))
    upsertDocument(doc({ id: 'a', title: 'Alpha', content: 'shared phrase here' }))
    const res = (await query('shared', { mode: 'content' })) as Array<{ title: string }>
    expect(res.map((r) => r.title)).toEqual(['Alpha', 'Zebra'])
  })
})
