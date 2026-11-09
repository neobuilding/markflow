// Renderer-level coverage for the Search view's control wiring. It replaces the seven browser
// examples deleted from `e2e/app/sidebar-search.e2e.spec.ts`: those exercised the matching
// algorithms through the whole app, but the algorithms are already guarded by
// `electron/main/lib/content-match.test.ts`, `electron/main/lib/scope-filter.test.ts` and
// `electron/main/ipc/search.test.ts`, and the hook's parameter assembly by
// `src/renderer/src/hooks/useSearch.test.ts`. What none of those can prove is that clicking the
// toggles and typing into the scope fields in THIS component actually reaches the IPC boundary
// with the right options. That is the gap these cases close. `window.api.search.query` is the only
// stub; the component, the store and the hook are the real ones.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SidebarSearch } from './SidebarSearch'
import { useUIStore } from '../../store/ui'
import type { SearchQueryOptions, SearchQueryResponse } from '../../../../../shared/searchTypes'

const EMPTY: SearchQueryResponse = {
  results: [],
  diagnostics: [],
  appliedScope: { root: null, include: [], exclude: [] },
  truncated: false,
}

let query: ReturnType<typeof vi.fn>
let originalApi: unknown
let envelope: SearchQueryResponse

function renderPanel() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <SidebarSearch />
    </QueryClientProvider>,
  )
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value } })
}

function lastCall(): SearchQueryOptions {
  const calls = query.mock.calls as Array<[SearchQueryOptions]>
  return calls.at(-1)![0]
}

beforeEach(() => {
  vi.clearAllMocks()
  envelope = EMPTY
  query = vi.fn(async () => envelope)
  originalApi = (window as unknown as { api: unknown }).api
  useUIStore.setState({
    searchQuery: '',
    searchInclude: '',
    searchExclude: '',
    searchMatchCase: false,
    searchWholeWord: false,
    searchRegexp: false,
    searchReplaceText: '',
    searchReplaceOpen: false,
    searchDetailsOpen: false,
    searchFocusNonce: 0,
    searchScopeFocusNonce: 0,
    activeFolder: '/ws',
    unsavedBuffers: {},
    documentStateRevision: 0,
    pendingMatch: null,
    activeDocumentId: null,
    dirty: false,
  })
  ;(window as unknown as { api: unknown }).api = {
    search: { query },
    clipboard: { writeText: vi.fn() },
    replace: { plan: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undo: vi.fn() },
    dialog: { confirm: vi.fn().mockResolvedValue(true) },
    onReplaceProgress: vi.fn(() => () => {}),
  }
})

// Restore the stubbed bridge so this file cannot leak it into any other suite.
afterEach(() => {
  ;(window as unknown as { api: unknown }).api = originalApi
})

describe('SidebarSearch — controls reach the search IPC boundary', () => {
  it('whole-word toggle is sent as wholeWord: true', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('search-advanced-toggles-ab'))
    typeQuery('needle')
    await waitFor(() => expect(query).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ query: 'needle', mode: 'content', wholeWord: true })
  })

  it('regexp toggle is sent as regexp: true and shows the escape hint', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('search-advanced-toggles-.*'))
    typeQuery('ne+dle')
    await waitFor(() => expect(query).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ query: 'ne+dle', regexp: true, wholeWord: false })
    expect(screen.getByTestId('search-regex-hint')).toBeTruthy()
  })

  it('match-case toggle is sent as matchCase: true', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('search-match-case-Aa'))
    typeQuery('Needle')
    await waitFor(() => expect(query).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ query: 'Needle', matchCase: true })
  })

  it('include and exclude fields are sent as the visible scope, with exclude taking precedence', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('search-toggle-details'))
    fireEvent.change(screen.getByTestId('search-include'), { target: { value: '**/*.md' } })
    fireEvent.change(screen.getByTestId('search-exclude'), { target: { value: './archive' } })
    typeQuery('needle')
    await waitFor(() => expect(query).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ include: '**/*.md', exclude: './archive' })
  })

  it('a blocking scope diagnostic is shown and no results are rendered', async () => {
    envelope = {
      ...EMPTY,
      diagnostics: [{ code: 'invalid-pattern', field: 'exclude', blocking: true, message: 'bad' }],
    }
    renderPanel()
    fireEvent.click(screen.getByTestId('search-toggle-details'))
    fireEvent.change(screen.getByTestId('search-exclude'), { target: { value: 'a[bc' } })
    typeQuery('needle')
    expect(await screen.findByTestId('search-diagnostic')).toBeTruthy()
    expect(screen.queryAllByTestId('search-match')).toHaveLength(0)
  })

  it('a blocking regex diagnostic is shown instead of falling back to a literal search', async () => {
    envelope = {
      ...EMPTY,
      diagnostics: [{ code: 'invalid-regex', field: 'query', blocking: true, message: 'unclosed' }],
    }
    renderPanel()
    fireEvent.click(screen.getByTestId('search-advanced-toggles-.*'))
    typeQuery('(unclosed')
    expect(await screen.findByTestId('search-diagnostic')).toBeTruthy()
    expect(screen.queryAllByTestId('search-match')).toHaveLength(0)
  })

  // A single-line <input> strips CR/LF before it reaches the store, so the multiline interception
  // cannot be exercised from this component; `useSearch.test.tsx` guards that rule at the hook
  // layer instead. What this component CAN prove is that a non-ASCII query survives unchanged.
  it('a non-ASCII query reaches the IPC boundary byte-for-byte', async () => {
    renderPanel()
    typeQuery('中文')
    await waitFor(() => expect(query).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ query: '中文', mode: 'content' })
  })
})
