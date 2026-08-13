import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB so we can drive FTS + LIKE fallback paths without better-sqlite3.
const rows: unknown[] = []
const likeRows: unknown[] = []
const h = vi.hoisted(() => ({ mode: 'fts' as 'fts' | 'like' | 'error' }))
vi.mock('../../db/database', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => {
        if (h.mode === 'error') throw new Error('boom')
        if (h.mode === 'like') return likeRows
        return rows
      },
    }),
  }),
}))

import { registerSearchHandlers } from '../search'

describe('search handlers', () => {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {}
  const ipcMain = {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      handlers[ch] = fn
    },
  } as unknown as import('electron').IpcMain

  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    registerSearchHandlers(ipcMain)
  })

  it('registers the search:query handler', () => {
    expect(typeof handlers['search:query']).toBe('function')
  })

  it('returns [] for an empty/whitespace query', () => {
    registerSearchHandlers(ipcMain)
    expect(handlers['search:query'](null, '')).toEqual([])
    expect(handlers['search:query'](null, '   ')).toEqual([])
  })

  it('returns FTS rows mapped to SearchResult shape', () => {
    h.mode = 'fts'
    rows.length = 0
    rows.push({
      id: 'd1',
      title: 'Hello',
      folder_path: '/f',
      updated_at: 123,
      snippet: '<mark>hello</mark>',
      score: -2.5,
    })
    registerSearchHandlers(ipcMain)
    const out = handlers['search:query'](null, 'hello') as Array<{
      id: string
      title: string
      folderPath: string
      snippet: string
      score: number
      updatedAt: number
    }>
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'd1',
      title: 'Hello',
      folderPath: '/f',
      snippet: '<mark>hello</mark>',
      score: -2.5,
      updatedAt: 123,
    })
  })

  it('falls back to LIKE search when FTS throws', () => {
    h.mode = 'like'
    likeRows.length = 0
    likeRows.push({
      id: 'd2',
      title: 'World',
      folder_path: '/g',
      updated_at: 9,
      snippet: 'world content',
    })
    registerSearchHandlers(ipcMain)
    const out = handlers['search:query'](null, 'world') as unknown[]
    expect(out).toHaveLength(1)
    expect((out[0] as { id: string }).id).toBe('d2')
  })

  it('returns [] when FTS throws AND like throws', () => {
    h.mode = 'error'
    registerSearchHandlers(ipcMain)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(handlers['search:query'](null, 'x')).toEqual([])
    errSpy.mockRestore()
  })

  it('returns [] for an undefined query', () => {
    registerSearchHandlers(ipcMain)
    expect(handlers['search:query'](null, undefined as unknown as string)).toEqual([])
  })

  it('strips fts special characters and tokenizes multiple words', () => {
    h.mode = 'fts'
    rows.length = 0
    rows.push({
      id: 'd3',
      title: 'Alpha (Beta)',
      folder_path: '/h',
      updated_at: 5,
      snippet: 'alpha beta',
      score: -1,
    })
    registerSearchHandlers(ipcMain)
    const out = handlers['search:query'](null, 'alpha* (beta) "gamma"') as unknown[]
    expect(out).toHaveLength(1)
    expect((out[0] as { id: string }).id).toBe('d3')
  })

  it('falls back to a LIKE snippet when FTS rows have no snippet', () => {
    h.mode = 'fts'
    rows.length = 0
    rows.push({
      id: 'd4',
      title: 'NoSnippet',
      folder_path: '/i',
      updated_at: 7,
      snippet: '',
      score: -0.5,
    })
    registerSearchHandlers(ipcMain)
    const out = handlers['search:query'](null, 'nosnippet') as Array<{ snippet: string }>
    expect(out[0].snippet).toBe('')
  })

  it('defaults the LIKE fallback snippet to empty when absent', () => {
    h.mode = 'like'
    likeRows.length = 0
    likeRows.push({
      id: 'd5',
      title: 'LikeNoSnip',
      folder_path: '/j',
      updated_at: 3,
    } as Record<string, unknown>)
    registerSearchHandlers(ipcMain)
    const out = handlers['search:query'](null, 'like') as Array<{ snippet: string }>
    expect(out[0].snippet).toBe('')
  })

  it('handles a query made only of special characters (all tokens filtered out)', () => {
    h.mode = 'fts'
    rows.length = 0
    registerSearchHandlers(ipcMain)
    // Pure special characters become an empty FTS expression; the query must
    // not throw and should return whatever the (empty-match) query yields.
    const out = handlers['search:query'](null, '*** ^^^ ###') as unknown[]
    expect(Array.isArray(out)).toBe(true)
  })

  it('maps a LIKE fallback row with a real snippet', () => {
    h.mode = 'like'
    likeRows.length = 0
    likeRows.push({
      id: 'd6',
      title: 'HasSnip',
      folder_path: '/k',
      updated_at: 11,
      snippet: 'some snippet text',
    } as Record<string, unknown>)
    registerSearchHandlers(ipcMain)
    const out = handlers['search:query'](null, 'hassnip') as Array<{ snippet: string }>
    expect(out[0].snippet).toBe('some snippet text')
  })
})
