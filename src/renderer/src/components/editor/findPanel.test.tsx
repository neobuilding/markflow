import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import {
  search,
  searchPanelOpen,
  getSearchQuery,
  setSearchQuery,
  findNext,
  SearchQuery,
} from '@codemirror/search'
import '../../i18n'
import { EditorFindPanel } from './findPanel'
import { createFindPanel } from './createFindPanel'
import { buildReplacement, replaceCurrentMatch, replaceAllMatches } from '../../lib/find-replace'

const views: EditorView[] = []
afterEach(() => {
  while (views.length) views.pop()?.destroy()
})

function makeView(doc: string): EditorView {
  const view = new EditorView({ doc, extensions: [search()] })
  document.body.appendChild(view.dom)
  views.push(view)
  return view
}

// `setSearchQuery` is a StateEffect in @codemirror/search.
function setQuery(view: EditorView, q: SearchQuery): void {
  act(() => view.dispatch({ effects: setSearchQuery.of(q) }))
}

describe('buildReplacement', () => {
  it('expands a backreference to a missing group as an empty string', () => {
    // `$3` has no capture group in '(a)(b)', so it collapses to ''.
    const q = new SearchQuery({ search: '(a)(b)', replace: 'x$3y', regexp: true })
    expect(buildReplacement(q, 'ab', false)).toBe('xy')
  })

  it('keeps the replacement verbatim when the match does not fit the pattern', () => {
    // `matched` never matches the pattern, so `m` is null and the replacement is untouched.
    const q = new SearchQuery({ search: 'zzz', replace: 'r', regexp: true })
    expect(buildReplacement(q, 'abc', false)).toBe('r')
  })

  it('uses the replacement verbatim for a plain-string query', () => {
    const q = new SearchQuery({ search: 'a', replace: 'b' })
    expect(buildReplacement(q, 'a', false)).toBe('b')
  })

  it('expands $n backreferences for a regexp query', () => {
    const q = new SearchQuery({ search: '(a)(b)', regexp: true, replace: '$2$1' })
    expect(buildReplacement(q, 'ab', false)).toBe('ba')
  })

  it('applies preserve-case to the replacement', () => {
    const q = new SearchQuery({ search: 'foo', replace: 'bar' })
    expect(buildReplacement(q, 'Foo', true)).toBe('Bar')
    expect(buildReplacement(q, 'FOO', true)).toBe('BAR')
  })
})

describe('replaceCurrentMatch', () => {
  it('does nothing when the query is empty', () => {
    const view = makeView('hello world')
    replaceCurrentMatch(view, false)
    expect(view.state.doc.toString()).toBe('hello world')
  })

  it('only moves to the next match when the selection is not a match', () => {
    const view = makeView('foo bar foo')
    setQuery(view, new SearchQuery({ search: 'foo' }))
    // selection collapsed at 0 is not a match range → just step on (selects the
    // first match rather than replacing it)
    act(() => replaceCurrentMatch(view, false))
    expect(view.state.doc.toString()).toBe('foo bar foo')
    expect(view.state.selection.main.head).toBe(3)
  })

  it('replaces the current match and steps on', () => {
    const view = makeView('foo bar foo')
    setQuery(view, new SearchQuery({ search: 'foo', replace: 'X' }))
    act(() => findNext(view))
    act(() => replaceCurrentMatch(view, false))
    expect(view.state.doc.toString()).toBe('X bar foo')
  })

  it('replaces with preserve-case', () => {
    const view = makeView('Foo bar Foo')
    setQuery(view, new SearchQuery({ search: 'foo', replace: 'baz' }))
    act(() => findNext(view))
    act(() => replaceCurrentMatch(view, true))
    expect(view.state.doc.toString()).toBe('Baz bar Foo')
  })
})

describe('replaceAllMatches', () => {
  it('does nothing when the query is empty', () => {
    const view = makeView('hello world')
    replaceAllMatches(view, false)
    expect(view.state.doc.toString()).toBe('hello world')
  })

  it('replaces every match', () => {
    const view = makeView('foo bar foo')
    setQuery(view, new SearchQuery({ search: 'foo', replace: 'X' }))
    act(() => replaceAllMatches(view, false))
    expect(view.state.doc.toString()).toBe('X bar X')
  })

  it('replaces every match with preserve-case', () => {
    const view = makeView('Foo bar foo')
    setQuery(view, new SearchQuery({ search: 'foo', replace: 'x' }))
    act(() => replaceAllMatches(view, true))
    expect(view.state.doc.toString()).toBe('X bar x')
  })
})

describe('EditorFindPanel', () => {
  it('shows the correct k / n on mount, without waiting for an update callback', () => {
    const view = makeView('foo bar foo')
    // Seed the search query before mounting. `registerUpdate` is a no-op here, so the counter
    // can ONLY come from the lazy initializer during the first render — previously it stayed
    // "0 / 0" until an effect pushed it in with a setState.
    setQuery(view, new SearchQuery({ search: 'foo' }))
    render(<EditorFindPanel view={view} editable registerUpdate={() => {}} />)
    expect(screen.getByTestId('editor-find-count-count').textContent).toBe('1 / 2')
  })

  it('reflects query changes in the search state and shows k / n', () => {
    const view = makeView('foo bar foo')
    const captured = { current: null as ((v: EditorView) => void) | null }
    render(
      <EditorFindPanel
        view={view}
        editable
        registerUpdate={(fn) => {
          captured.current = fn
        }}
      />,
    )
    const input = screen.getByTestId('editor-find-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    act(() => captured.current?.(view))
    expect(getSearchQuery(view.state).search).toBe('foo')
    expect(screen.getByTestId('editor-find-count-count').textContent).toBe('1 / 2')
  })

  it('toggles case / word / regex into the search state', () => {
    const view = makeView('foo bar foo')
    render(<EditorFindPanel view={view} editable registerUpdate={() => {}} />)
    fireEvent.click(screen.getByTestId('editor-find-toggles-case'))
    expect(getSearchQuery(view.state).caseSensitive).toBe(true)
    fireEvent.click(screen.getByTestId('editor-find-toggles-word'))
    expect(getSearchQuery(view.state).wholeWord).toBe(true)
    fireEvent.click(screen.getByTestId('editor-find-toggles-regex'))
    expect(getSearchQuery(view.state).regexp).toBe(true)
  })

  it('toggles preserve case without touching the search state', () => {
    const view = makeView('foo bar foo')
    render(<EditorFindPanel view={view} editable registerUpdate={() => {}} />)
    fireEvent.click(screen.getByTestId('editor-find-toggles-preserve'))
    expect(screen.getByTestId('editor-find-toggles-preserve').getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(getSearchQuery(view.state).regexp).toBe(false)
  })

  it('steps prev / next and closes the panel', () => {
    const view = makeView('foo bar foo')
    render(<EditorFindPanel view={view} editable registerUpdate={() => {}} />)
    fireEvent.change(screen.getByTestId('editor-find-input'), { target: { value: 'foo' } })
    fireEvent.click(screen.getByTestId('editor-find-count-next'))
    // first next selects the match at 0; a second next lands on the match at 8
    fireEvent.click(screen.getByTestId('editor-find-count-next'))
    expect(view.state.selection.main.from).toBe(8)
    fireEvent.click(screen.getByTestId('editor-find-count-prev'))
    expect(view.state.selection.main.from).toBe(0)
    fireEvent.click(screen.getByTestId('editor-find-close'))
    expect(searchPanelOpen(view.state)).toBe(false)
  })

  it('replaces next and replace all when editable', () => {
    const view = makeView('foo bar foo')
    render(<EditorFindPanel view={view} editable registerUpdate={() => {}} />)
    fireEvent.change(screen.getByTestId('editor-find-input'), { target: { value: 'foo' } })
    fireEvent.change(screen.getByTestId('editor-find-replace'), { target: { value: 'X' } })
    fireEvent.click(screen.getByTestId('editor-find-count-next'))
    fireEvent.click(screen.getByTestId('editor-find-replace-btn'))
    expect(view.state.doc.toString()).toBe('X bar foo')
    fireEvent.click(screen.getByTestId('editor-find-replace-all'))
    expect(view.state.doc.toString()).toBe('X bar X')
  })

  it('hides the replace row when not editable', () => {
    const view = makeView('foo bar foo')
    render(<EditorFindPanel view={view} editable={false} registerUpdate={() => {}} />)
    expect(screen.queryByTestId('editor-find-replace')).toBeNull()
    expect(screen.queryByTestId('editor-find-toggles-preserve')).toBeNull()
  })
})

describe('createFindPanel', () => {
  it('returns a top-anchored panel whose update/destroy are safe', () => {
    const view = makeView('foo bar foo')
    const panel = createFindPanel(view, { editable: true })
    expect(panel.top).toBe(true)
    expect(panel.dom).toBeInstanceOf(HTMLDivElement)
    expect(() => panel.update?.({ view } as never)).not.toThrow()
    expect(() => panel.destroy?.()).not.toThrow()
  })

  it('defaults to a non-editable panel when no options are passed', () => {
    // Covers the `opts = { editable: false }` default parameter.
    const view = makeView('foo bar foo')
    const panel = createFindPanel(view)
    expect(panel.top).toBe(true)
    panel.destroy?.()
  })
})

describe('EditorFindPanel toggle merging', () => {
  it('merges case / whole-word / regexp into the live search query', () => {
    const view = makeView('foo bar foo')
    setQuery(view, new SearchQuery({ search: 'foo', caseSensitive: false }))
    render(<EditorFindPanel view={view} editable registerUpdate={() => {}} />)
    fireEvent.click(screen.getByTestId('editor-find-toggles-case'))
    expect(getSearchQuery(view.state).caseSensitive).toBe(true)
    fireEvent.click(screen.getByTestId('editor-find-toggles-word'))
    expect(getSearchQuery(view.state).wholeWord).toBe(true)
    fireEvent.click(screen.getByTestId('editor-find-toggles-regex'))
    expect(getSearchQuery(view.state).regexp).toBe(true)
    // mergeQuery keeps the existing search term when the patch omits `search`.
    expect(getSearchQuery(view.state).search).toBe('foo')
  })

  it('flips preserve-case locally without touching the search query', () => {
    const view = makeView('foo bar foo')
    setQuery(view, new SearchQuery({ search: 'foo' }))
    render(<EditorFindPanel view={view} editable registerUpdate={() => {}} />)
    const btn = screen.getByTestId('editor-find-toggles-preserve')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    expect(screen.getByTestId('editor-find-toggles-preserve').getAttribute('aria-pressed')).toBe(
      'true',
    )
  })
})
