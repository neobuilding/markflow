import { EditorView } from '@codemirror/view'
import { SearchQuery, getSearchQuery, findNext } from '@codemirror/search'
import { preserveCase } from './preserve-case'

// Preserve-case aware REPLACEMENT helpers for the editor's find panel. They operate on the
// CodeMirror view rather than on React state, which is why they live in `lib/` beside the
// other CM-facing helpers (`find-matches`, `preserve-case`) — and why they are kept out of
// the component module, so that module exports only components (Fast Refresh).

// Build the final replacement string for one match. For regexp queries, `$n`
// backreferences in the user's replacement are expanded against the matched text;
// for plain-string queries the replacement is used verbatim. Preserve-case then
// rewrites the result to follow the original match's case shape.
export function buildReplacement(query: SearchQuery, matched: string, preserve: boolean): string {
  let replacement = query.replace
  if (query.regexp) {
    const m = matched.match(new RegExp(query.search))
    if (m) replacement = query.replace.replace(/\$(\d+)/g, (_sub, d) => m[Number(d)] ?? '')
  }
  return preserve ? preserveCase(matched, replacement) : replacement
}

// Replace the current match and step to the next (preserve-case aware). Mirrors
// CodeMirror's `replaceNext`: if the selection is not exactly a match, only move
// to the next match; if it is, replace it first.
export function replaceCurrentMatch(view: EditorView, preserve: boolean): void {
  const q = getSearchQuery(view.state)
  if (!q.valid || q.search === '') return
  const sel = view.state.selection.main
  const cursor = q.getCursor(view.state.doc, sel.from)
  const res = cursor.next()
  const isCurrentMatch = !res.done && res.value.from === sel.from && res.value.to === sel.to
  if (isCurrentMatch) {
    const matched = view.state.sliceDoc(sel.from, sel.to)
    const replacement = buildReplacement(q, matched, preserve)
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: replacement },
      selection: { anchor: sel.from + replacement.length },
    })
    findNext(view)
  } else {
    findNext(view)
  }
}

// Replace every match (preserve-case aware). Changes are applied from the end of
// the document backwards so earlier offsets stay valid.
export function replaceAllMatches(view: EditorView, preserve: boolean): void {
  const q = getSearchQuery(view.state)
  if (!q.valid || q.search === '') return
  const changes: Array<{ from: number; to: number; insert: string }> = []
  const cursor = q.getCursor(view.state.doc)
  let res = cursor.next()
  while (!res.done) {
    const m = res.value
    const matched = view.state.sliceDoc(m.from, m.to)
    changes.push({ from: m.from, to: m.to, insert: buildReplacement(q, matched, preserve) })
    res = cursor.next()
  }
  changes.reverse()
  view.dispatch({ changes })
}
