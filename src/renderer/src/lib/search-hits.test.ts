import { describe, it, expect } from 'vitest'
import { flattenHitOrder, hitOrderIndex, hitKey } from './search-hits'
import type { SearchResult } from '../types'

function result(id: string, matches: SearchResult['matches']): SearchResult {
  return {
    id,
    title: id,
    folderPath: '',
    filePath: `/docs/${id}.md`,
    score: 0,
    updatedAt: 0,
    matches,
  }
}

const a = result('a', [
  { line: 1, start: 0, end: 3, excerpt: 'the cat', excerptStart: 0, excerptEnd: 3 },
  { line: 3, start: 20, end: 23, excerpt: 'and the dog', excerptStart: 4, excerptEnd: 7 },
])
const b = result('b', [
  { line: 2, start: 10, end: 13, excerpt: 'find the fox', excerptStart: 5, excerptEnd: 8 },
])
const empty = result('c', [])

describe('flattenHitOrder', () => {
  it('lists every content-mode occurrence, in document order', () => {
    expect(flattenHitOrder([a, b, empty], 'content')).toEqual([
      { id: 'a', start: 0, end: 3 },
      { id: 'a', start: 20, end: 23 },
      { id: 'b', start: 10, end: 13 },
    ])
  })

  it('skips documents without literal hits (fuzzy-only matches render no rows)', () => {
    expect(flattenHitOrder([empty], 'content')).toEqual([])
  })

  it('lists one row per file in filename mode', () => {
    expect(flattenHitOrder([a, b, empty], 'filename')).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ])
  })
})

describe('hitOrderIndex', () => {
  it('maps each occurrence to its flat index', () => {
    const index = hitOrderIndex([a, b, empty], 'content')
    expect(index.get(hitKey('a', 0))).toBe(0)
    expect(index.get(hitKey('a', 20))).toBe(1)
    expect(index.get(hitKey('b', 10))).toBe(2)
  })

  it('treats an offset of 0 as a real hit, not a missing one', () => {
    // A truthiness test would drop start === 0; the key must distinguish them.
    expect(hitKey('a', 0)).not.toBe(hitKey('a'))
    expect(hitOrderIndex([a], 'content').get(hitKey('a', 0))).toBe(0)
  })

  it('indexes file rows by id alone in filename mode', () => {
    const index = hitOrderIndex([a, b], 'filename')
    expect(index.get(hitKey('a'))).toBe(0)
    expect(index.get(hitKey('b'))).toBe(1)
  })
})
