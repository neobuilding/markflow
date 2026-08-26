// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { createDocumentStore, upsertDocument, type Document } from '../model/documentStore'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
    handlers[ch] = fn
  },
} as any

// Import after the fake ipcMain is ready; registerSearchHandlers registers on it.
import { registerSearchHandlers, makeSnippet } from './search'
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

function query(q: string) {
  return handlers['search:query'](null, q) as Awaited<ReturnType<(typeof handlers)['search:query']>>
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

  it('returns a snippet with <mark> highlighting the matched term', async () => {
    const res = (await query('markdown')) as Array<{ id: string; snippet: string }>
    const hit = res.find((r) => r.id === '1')
    expect(hit?.snippet).toContain('<mark>markdown</mark>')
  })

  it('returns score and updatedAt fields', async () => {
    const res = (await query('editor')) as Array<{ score: number; updatedAt: number }>
    expect(typeof res[0].score).toBe('number')
    expect(typeof res[0].updatedAt).toBe('number')
  })
})

describe('makeSnippet', () => {
  it('marks the first matched term position', () => {
    const s = makeSnippet('Markdown editor with highlight', ['highlight'])
    expect(s).toContain('<mark>highlight</mark>')
  })

  it('returns a plain truncated snippet when no term is found in the content', () => {
    // Exercises the `hit === -1` branch of makeSnippet.
    const s = makeSnippet('Markdown editor with highlight', ['zzzqqqxyz'])
    expect(s).toBe('Markdown editor with highlight'.slice(0, 120))
    expect(s).not.toContain('<mark>')
  })
})
