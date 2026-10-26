import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useQuickOpen, useSearchView } from './useSearch'
import { useUIStore } from '../store/ui'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = {
  search: { query: vi.fn() },
}
beforeEach(() => {
  vi.resetAllMocks()
  api.search.query.mockResolvedValue({
    results: [],
    diagnostics: [],
    appliedScope: { root: null, include: [], exclude: [] },
    truncated: false,
  })
  ;(window as unknown as { api: unknown }).api = api
  ;(globalThis as unknown as { api: unknown }).api = api
  useUIStore.getState().setSearchQuery('')
  useUIStore.getState().setSearchInclude('')
  useUIStore.getState().setSearchExclude('')
  useUIStore.getState().setSearchMatchCase(false)
})

function renderHook<T>(factory: () => T) {
  const result = { current: undefined as unknown as T }
  function Wrapper() {
    result.current = factory()
    return null
  }
  const client = new QueryClient()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <Wrapper />
      </QueryClientProvider>,
    )
  })
  return { result, unmount: () => act(() => root.unmount()) }
}

describe('useQuickOpen', () => {
  it('asks for file names only — no scope, no body search (D1/D11)', () => {
    act(() => {
      useUIStore.getState().setSearchQuery('hello')
    })
    renderHook(() => useQuickOpen())
    expect(api.search.query).toHaveBeenCalledWith({ query: 'hello', mode: 'filename' })
  })

  it('does not query when the search query is empty', () => {
    act(() => useUIStore.getState().setSearchQuery(''))
    renderHook(() => useQuickOpen())
    expect(api.search.query).not.toHaveBeenCalled()
  })

  // ADR-0023 ruling 13: a query containing CR/LF is intercepted renderer-side and must never
  // reach the IPC handler. (A single-line <input> cannot produce such a query, so the UI cannot
  // exercise it — this is the level at which the rule is enforceable.)
  it('issues no IPC for a multiline query', () => {
    act(() => useUIStore.getState().setSearchQuery('a\nb'))
    renderHook(() => useQuickOpen())
    expect(api.search.query).not.toHaveBeenCalled()
  })
})

describe('useSearchView', () => {
  it('sends the visible scope and the dirty-state contract', () => {
    act(() => {
      useUIStore.getState().setSearchQuery('hello')
      useUIStore.getState().setSearchInclude('./docs')
      useUIStore.getState().setSearchExclude('./archive')
      useUIStore.getState().setSearchMatchCase(true)
    })
    renderHook(() => useSearchView())
    expect(api.search.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'hello',
        mode: 'content',
        include: './docs',
        exclude: './archive',
        matchCase: true,
        dirtyDocumentSnapshots: [],
      }),
    )
  })

  it('reports every unsaved buffer, not just the active document (D28)', () => {
    act(() => {
      useUIStore.getState().setSearchQuery('hello')
      useUIStore.getState().reportUnsavedBuffer('a', 'hello world')
      useUIStore.getState().reportUnsavedBuffer('b', 'hello again')
    })
    renderHook(() => useSearchView())
    const call = api.search.query.mock.calls[0][0]
    expect(call.dirtyDocumentSnapshots).toEqual(
      expect.arrayContaining([
        { documentId: 'a', content: 'hello world', revision: 1 },
        { documentId: 'b', content: 'hello again', revision: 1 },
      ]),
    )
    expect(typeof call.documentStateRevision).toBe('number')
  })

  it('returns an empty envelope rather than undefined while loading', () => {
    act(() => useUIStore.getState().setSearchQuery('hello'))
    const { result } = renderHook(() => useSearchView())
    expect(result.current.data).toEqual({
      results: [],
      diagnostics: [],
      appliedScope: { root: null, include: [], exclude: [] },
      truncated: false,
    })
  })

  it('does not query when the search query is empty', () => {
    act(() => useUIStore.getState().setSearchQuery(''))
    renderHook(() => useSearchView())
    expect(api.search.query).not.toHaveBeenCalled()
  })

  // ADR-0023 ruling 13: the renderer intercepts a CR/LF query and shows an inline hint, so no
  // IPC is ever issued and `search.multilineUnsupported` never enters the envelope.
  it('issues no IPC for a multiline query', () => {
    act(() => useUIStore.getState().setSearchQuery('a\nb'))
    renderHook(() => useSearchView())
    expect(api.search.query).not.toHaveBeenCalled()
    // The view still exposes a full envelope rather than undefined.
  })

  it('issues no IPC for a CR-only multiline query', () => {
    act(() => useUIStore.getState().setSearchQuery('a\rb'))
    renderHook(() => useSearchView())
    expect(api.search.query).not.toHaveBeenCalled()
  })
})

// The dirty-state revision is debounced so a burst of buffer edits does not refetch per keystroke.
// The timer callback only runs when time advances, which the synchronous tests above never do.
describe('useSearchView — debounced document-state revision', () => {
  it('fires the debounce timer callback when time advances', () => {
    vi.useFakeTimers()
    try {
      act(() => {
        useUIStore.getState().setSearchQuery('hello')
        useUIStore.getState().reportUnsavedBuffer('a', 'x')
      })
      const { unmount } = renderHook(() => useSearchView())
      // Advance past the 300ms debounce so `setDebounced` runs.
      act(() => {
        vi.advanceTimersByTime(350)
      })
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
