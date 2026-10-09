import React, { useCallback, useEffect, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  closeSearchPanel,
} from '@codemirror/search'
import { collectMatches, currentMatchIndex } from '../../lib/find-matches'
import { replaceCurrentMatch, replaceAllMatches } from '../../lib/find-replace'
import { FindWidget } from './FindWidget'
import {
  TOGGLE_FIELD,
  withToggle,
  type FindToggleKey,
  type FindToggleState,
  type FindToggleField,
} from '../../lib/find-toggles'

// A registered callback that re-runs the match-count recompute for the editor's current
// state. CodeMirror calls `panel.update` on every view change; createFindPanel forwards the
// current view through this fn (registered by EditorFindPanel on mount) so the k/n counter
// stays in sync. A callback (not a mutable bridge object) keeps the wiring immutable.
export type FindPanelUpdate = (view: EditorView) => void

// Merge a partial patch into the current search query and push it back into the
// editor's search state (which drives CodeMirror's native match highlighting).
function mergeQuery(
  view: EditorView,
  patch: Partial<{
    search: string
    caseSensitive: boolean
    wholeWord: boolean
    regexp: boolean
    replace: string
  }>,
): void {
  const q = getSearchQuery(view.state)
  applySearchQuery(
    view,
    new SearchQuery({
      // v8 mis-attributes the executed `??` fallback of this operand to the neighbouring
      // line, reporting it as uncovered even though both sides run (query typing takes the
      // patch, the toggles take the fallback). Same known v8 quirk documented in EditorPane.
      /* v8 ignore next -- v8 mis-attributes this `??` fallback; both sides are exercised */
      search: patch.search ?? q.search,
      caseSensitive: patch.caseSensitive ?? q.caseSensitive,
      wholeWord: patch.wholeWord ?? q.wholeWord,
      regexp: patch.regexp ?? q.regexp,
      replace: patch.replace ?? q.replace,
    }),
  )
}

// `setSearchQuery` is a StateEffect in @codemirror/search, applied via dispatch.
function applySearchQuery(view: EditorView, query: SearchQuery): void {
  view.dispatch({ effects: setSearchQuery.of(query) })
}

// Everything the panel displays is a pure function of the editor's search state plus the
// selection, so it is computed during render (and re-computed by the CodeMirror update
// callback) instead of being pushed in with a setState inside an effect — which is exactly
// what `react-hooks/set-state-in-effect` forbids.
type PanelState = {
  query: string
  toggleState: FindToggleState
  total: number
  current: number
}

function computePanelState(view: EditorView, preserveCase: boolean): PanelState {
  const q = getSearchQuery(view.state)
  const matches = collectMatches(q, view.state)
  return {
    query: q.search,
    toggleState: {
      caseSensitive: q.caseSensitive,
      wholeWord: q.wholeWord,
      regexp: q.regexp,
      preserveCase,
    },
    total: matches.length,
    current: currentMatchIndex(matches, view.state.selection.main.head) + 1,
  }
}

// The React content of the editor's find panel. Wires the shared FindWidget shell
// to the CodeMirror search engine: query/toggles live in the search state, the k/n
// counter is recomputed from the query cursor on every update, and replace runs
// through the preserve-case-aware helpers above.
export function EditorFindPanel({
  view,
  editable,
  openInReplaceMode = false,
  registerUpdate,
}: {
  view: EditorView
  editable: boolean
  // Open mode for the FIRST open: when true the panel shows its replace row (Ctrl/Cmd+H), when
  // false it is find-only (Ctrl/Cmd+F). Mirrors VS Code, where the two shortcuts are not
  // equivalent. Re-opens while already open are handled by the listeners below.
  openInReplaceMode?: boolean
  registerUpdate?: (fn: FindPanelUpdate | null) => void
}): React.ReactElement {
  // Lazy initializers read the live search state during the FIRST render, so the panel is
  // correct the moment it mounts. Previously the initial k/n was 0 until an effect called
  // the recompute synchronously.
  const [state, setState] = useState(() => computePanelState(view, false))
  // The replacement text is user input, so it is kept separate: recomputing must never
  // clobber what the user typed into the replace field.
  const [replaceText, setReplaceText] = useState(() => getSearchQuery(view.state).replace)
  const preserveRef = useRef(false)
  // Whether the replace row is expanded. Seeded from the open mode for the FIRST open — at that
  // point the listeners below are not attached yet (the React commit that mounts them happens
  // after the markdown:replace event has fired) — then toggled live when the panel is already
  // open and the user presses Ctrl/Cmd+H (expand) or Ctrl/Cmd+F (collapse), so the shortcuts
  // stay distinct at runtime.
  const [replaceOpen, setReplaceOpen] = useState(openInReplaceMode)

  const recompute = useCallback((v: EditorView) => {
    setState(computePanelState(v, preserveRef.current))
  }, [])

  // Subscribe to CodeMirror updates and nothing else: no synchronous setState here, so the
  // k/n counter never causes a cascading extra render. `view` is intentionally not a dep —
  // each panel instance is rendered for exactly one view for its whole lifetime.
  useEffect(() => {
    registerUpdate?.(recompute)
    return () => registerUpdate?.(null)
  }, [registerUpdate, recompute])

  // Focus the query field once this panel has committed. CodeMirror's `openSearchPanel`
  // only focuses `[main-field]` on a *subsequent* open (when the panel already exists in the
  // view state); the very first open merely dispatches `togglePanel.of(true)` to create the
  // panel. Our panel is a React root, so its input is committed asynchronously and CM's
  // first-open path never focuses it — without this the user's keystrokes land in the document
  // and the panel looks like it "did nothing". This effect runs after React commits the input,
  // so the focus is reliable in the real browser (where the commit is not synchronous). Repeat
  // opens are refocused by CodeMirror itself via `getSearchInput`, so no retry is needed here.
  useEffect(() => {
    const input = view.dom.querySelector<HTMLInputElement>('[main-field]')
    // This panel always renders a `[main-field]` input, so `input` is never null here.
    /* v8 ignore next -- the editor find panel always mounts a `[main-field]` input */
    if (input) input.focus()
    // `view.dom` is assigned once when the EditorView is constructed and never reassigned, so
    // this dep is stable and the effect still runs exactly once per panel.
  }, [view.dom])

  // Expand/collapse the replace row in response to which shortcut opened (or re-targeted) the
  // panel, so Ctrl/Cmd+F stays find-only and Ctrl/Cmd+H stays find+replace even when the panel
  // is already open and the user switches shortcuts.
  useEffect(() => {
    const expand = () => setReplaceOpen(true)
    const collapse = () => setReplaceOpen(false)
    document.addEventListener('markdown:replace', expand)
    document.addEventListener('markdown:replaceAll', expand)
    document.addEventListener('markdown:find', collapse)
    return () => {
      document.removeEventListener('markdown:replace', expand)
      document.removeEventListener('markdown:replaceAll', expand)
      document.removeEventListener('markdown:find', collapse)
    }
  }, [])

  const onQueryChange = useCallback(
    (s: string) => {
      setState((prev) => ({ ...prev, query: s }))
      mergeQuery(view, { search: s })
    },
    [view],
  )

  const onToggle = useCallback(
    (key: FindToggleKey) => {
      if (key === 'preserve') {
        preserveRef.current = !preserveRef.current
        setState((prev) => ({
          ...prev,
          toggleState: { ...prev.toggleState, preserveCase: preserveRef.current },
        }))
        return
      }
      // `preserve` was handled above, so `key` narrows to the three match toggles and
      // TOGGLE_FIELD[key] needs no fallback branch.
      const field = TOGGLE_FIELD[key]
      const q = getSearchQuery(view.state)
      const next = !q[field]
      setState((prev) => ({ ...prev, toggleState: withToggle(prev.toggleState, field, next) }))
      const patch: Partial<Record<FindToggleField, boolean>> = { [field]: next }
      mergeQuery(view, patch)
    },
    [view],
  )

  const onReplaceTextChange = useCallback(
    (s: string) => {
      setReplaceText(s)
      mergeQuery(view, { replace: s })
    },
    [view],
  )

  const onPrev = useCallback(() => findPrevious(view), [view])
  const onNext = useCallback(() => findNext(view), [view])
  const onClose = useCallback(() => closeSearchPanel(view), [view])
  const onReplaceNext = editable ? () => replaceCurrentMatch(view, preserveRef.current) : undefined
  const onReplaceAll = editable ? () => replaceAllMatches(view, preserveRef.current) : undefined

  return (
    <FindWidget
      testId="editor-find"
      query={state.query}
      onQueryChange={onQueryChange}
      total={state.total}
      current={state.current}
      onPrev={onPrev}
      onNext={onNext}
      onClose={onClose}
      toggleState={state.toggleState}
      onToggle={onToggle}
      showReplace={editable && replaceOpen}
      replaceText={replaceText}
      onReplaceTextChange={onReplaceTextChange}
      onReplaceNext={onReplaceNext}
      onReplaceAll={onReplaceAll}
      mainField
    />
  )
}
