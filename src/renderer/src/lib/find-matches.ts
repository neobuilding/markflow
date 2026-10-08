import { SearchQuery } from '@codemirror/search'
import type { EditorState, Text } from '@codemirror/state'

export interface MatchRange {
  from: number
  to: number
}

// Collect every match of `query` across `doc`. Returns an empty array when the
// query is empty or invalid (invalid regexp). Uses the query's own cursor so it
// mirrors CodeMirror's exact matching semantics (case / whole-word / regexp).
export function collectMatches(query: SearchQuery, doc: EditorState | Text): MatchRange[] {
  const ranges: MatchRange[] = []
  if (!query.valid || query.search === '') return ranges
  const cursor = query.getCursor(doc)
  let res = cursor.next()
  while (!res.done) {
    ranges.push({ from: res.value.from, to: res.value.to })
    res = cursor.next()
  }
  return ranges
}

// Index (1-based position is `index + 1`) of the match that should be reported
// as "current" given the caret `head`:
//   - a match that contains the caret, else
//   - the first match starting after the caret, else
//   - 0 (the caret is past the last match → wrap to the first).
// Falls back to 0 when there are no matches.
export function currentMatchIndex(matches: MatchRange[], head: number): number {
  if (matches.length === 0) return 0
  const contained = matches.findIndex((m) => head >= m.from && head <= m.to)
  if (contained !== -1) return contained
  const after = matches.findIndex((m) => m.from > head)
  if (after !== -1) return after
  return 0
}
