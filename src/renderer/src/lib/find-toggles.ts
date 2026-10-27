// Find-widget toggle plumbing, shared by the editor's find panel and the preview's find bar.
//
// The two surfaces used to each hand-roll the same `case / word / regex` if-cascade, differing
// only in which boolean they flipped. Both now read the mapping from here, so a third find surface
// (or a renamed field) cannot drift between them.

// Which toggle the FindWidget can raise. `preserve` is replace-only: it has no effect on matching,
// and the preview (find-only, never replace) does not render it at all.
export type FindToggleKey = 'case' | 'word' | 'regex' | 'preserve'

export interface FindToggleState {
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
  preserveCase: boolean
}

// The three toggles that actually change how the query MATCHES.
export type FindMatchToggleKey = 'case' | 'word' | 'regex'
export type FindToggleField = 'caseSensitive' | 'wholeWord' | 'regexp'

// Toggle key -> the FindToggleState field it flips. Keyed by FindMatchToggleKey (not FindToggleKey)
// on purpose: callers handle `preserve` first and return, so TypeScript narrows the key to these
// three and `TOGGLE_FIELD[key]` needs neither a cast nor a dead "unknown key" fallback branch.
export const TOGGLE_FIELD: Record<FindMatchToggleKey, FindToggleField> = {
  case: 'caseSensitive',
  word: 'wholeWord',
  regex: 'regexp',
}

// Return `state` with one match flag flipped. Both find surfaces need exactly this shape, and it
// keeps the computed-key write type-safe (a literal `{ [field]: value }` would widen to an index
// signature and lose the FindToggleState type).
export function withToggle(
  state: FindToggleState,
  field: FindToggleField,
  value: boolean,
): FindToggleState {
  const next: FindToggleState = { ...state }
  next[field] = value
  return next
}
