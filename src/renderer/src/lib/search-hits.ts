import type { SearchResult, SearchMode } from '../types'

// One in-document occurrence, in the FLAT order the UI renders and navigates. `start`/`end`
// are the document-wide character offsets and are present only for content-mode hits; a file
// row (filename mode) carries just `id`.
export type HitItem = { id: string; start?: number; end?: number }

// The flat hit order: content mode lists every in-document occurrence, filename mode lists one
// row per file.
//
// This is the SINGLE source of truth for that order. The resident panel's keyboard navigation
// (`selectedIndex`) and SearchPanel's rendered rows must agree exactly, and deriving both from
// one function is what keeps them from drifting — previously each computed the sequence
// separately behind a "must match" comment.
export function flattenHitOrder(results: SearchResult[], mode: SearchMode): HitItem[] {
  if (mode === 'content') {
    return results
      .filter((r) => r.matches.length > 0)
      .flatMap((r) => r.matches.map((m) => ({ id: r.documentId, start: m.start, end: m.end })))
  }
  return results.map((r) => ({ id: r.documentId }))
}

// Lookup from an occurrence to its flat index, keyed the same way SearchPanel keys its rows.
// Documents whose `matches` is empty are absent here (they render no hit rows).
export function hitOrderIndex(results: SearchResult[], mode: SearchMode): Map<string, number> {
  const index = new Map<string, number>()
  flattenHitOrder(results, mode).forEach((item, i) => {
    index.set(hitKey(item.id, item.start), i)
  })
  return index
}

// Stable per-occurrence key. `start` may legitimately be 0, so it cannot be tested with
// truthiness.
export function hitKey(id: string, start?: number): string {
  return start === undefined ? id : `${id}:${start}`
}
