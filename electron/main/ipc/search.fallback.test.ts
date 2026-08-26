// @vitest-environment node
//
// Coverage of the `tokenize` Intl.Segmenter fallback branch (search.ts lines
// 41-44): when `Intl.Segmenter` is unavailable, tokenize must fall back to a
// `\p{P}` punctuation split. search.ts only caches `segmenter` lazily inside
// getSegmenter() (on first query), so deleting the global before the first
// query is enough — the module import itself never touches Intl.Segmenter.
// Vitest isolates each file's module graph, so this does not affect the other
// search suite.
import { describe, it, expect, beforeAll } from 'vitest'
import { upsertDocument } from '../model/documentStore'
import { registerSearchHandlers } from './search'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
    handlers[ch] = fn
  },
} as unknown as import('electron').IpcMain

describe('tokenize fallback (no Intl.Segmenter)', () => {
  beforeAll(async () => {
    // Remove Intl.Segmenter before the first query so getSegmenter() caches null.
    delete (Intl as unknown as { Segmenter?: unknown }).Segmenter
    registerSearchHandlers(fakeIpcMain)
    await upsertDocument({
      id: '1',
      title: 'Markdown Editor',
      folderPath: '/docs',
      filePath: '/docs/a.md',
      content: 'Markdown editor with syntax highlighting. 检索中文文档。',
      encoding: 'utf-8',
      encodingConfidence: 1,
      createdAt: 1,
      updatedAt: 1,
      wordCount: 4,
    })
  })

  it('still tokenizes and matches without Intl.Segmenter', async () => {
    const res = (await handlers['search:query']!('evt', 'markdown')) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toContain('1')
  })

  it('matches Chinese text via the punctuation-split fallback', async () => {
    const res = (await handlers['search:query']!('evt', '检索')) as Array<{ id: string }>
    expect(res.map((r) => r.id)).toContain('1')
  })
})
