import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { SearchQuery } from '@codemirror/search'
import { collectMatches, currentMatchIndex } from './find-matches'

function state(doc: string): EditorState {
  return EditorState.create({ doc })
}

describe('collectMatches', () => {
  it('returns no matches for an empty query', () => {
    const q = new SearchQuery({ search: '' })
    expect(collectMatches(q, state('hello hello'))).toEqual([])
  })

  it('returns no matches for an invalid regexp query', () => {
    const q = new SearchQuery({ search: '(', regexp: true })
    expect(collectMatches(q, state('hello'))).toEqual([])
  })

  it('collects every plain-string match', () => {
    const q = new SearchQuery({ search: 'hello' })
    const ranges = collectMatches(q, state('hello world hello'))
    expect(ranges).toEqual([
      { from: 0, to: 5 },
      { from: 12, to: 17 },
    ])
  })

  it('respects case sensitivity', () => {
    const q = new SearchQuery({ search: 'Hello', caseSensitive: true })
    expect(collectMatches(q, state('hello Hello'))).toEqual([{ from: 6, to: 11 }])
  })

  it('respects whole-word matching', () => {
    const q = new SearchQuery({ search: 'abc', wholeWord: true })
    const ranges = collectMatches(q, state('foo abc bar abc baz'))
    // Both standalone "abc" occurrences match; the one inside "abcd" would not.
    expect(ranges).toEqual([
      { from: 4, to: 7 },
      { from: 12, to: 15 },
    ])
  })

  it('respects regexp matching', () => {
    const q = new SearchQuery({ search: 'a.c', regexp: true })
    expect(collectMatches(q, state('abc adc'))).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ])
  })
})

describe('currentMatchIndex', () => {
  const matches = [
    { from: 0, to: 5 },
    { from: 12, to: 17 },
  ]

  it('returns 0 when there are no matches', () => {
    expect(currentMatchIndex([], 0)).toBe(0)
  })

  it('returns the match that contains the caret', () => {
    expect(currentMatchIndex(matches, 2)).toBe(0)
    expect(currentMatchIndex(matches, 14)).toBe(1)
  })

  it('returns the first match starting after the caret', () => {
    expect(currentMatchIndex(matches, 6)).toBe(1)
  })

  it('wraps to 0 when the caret is past the last match', () => {
    expect(currentMatchIndex(matches, 100)).toBe(0)
  })
})
