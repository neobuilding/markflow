import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SidebarSearch } from './SidebarSearch'
import { useUIStore } from '../../store/ui'
import type { SearchResult } from '../../types'

function makeResult(over: Partial<SearchResult> & { id: string }): SearchResult {
  return {
    title: 'Doc',
    folderPath: '',
    filePath: '/docs/doc.md',
    snippet: '',
    score: 0,
    updatedAt: 0,
    matches: [],
    ...over,
  }
}

const contentResults: SearchResult[] = [
  makeResult({
    id: 'a',
    title: 'Alpha',
    matches: [
      { line: 1, start: 0, end: 3, excerpt: 'the cat sat', excerptStart: 0, excerptEnd: 3 },
      { line: 3, start: 20, end: 23, excerpt: 'and the dog ran', excerptStart: 4, excerptEnd: 7 },
    ],
  }),
  makeResult({
    id: 'b',
    title: 'Beta',
    matches: [
      { line: 2, start: 10, end: 13, excerpt: 'find the fox', excerptStart: 5, excerptEnd: 8 },
    ],
  }),
]

const fileResults: SearchResult[] = [
  makeResult({ id: 'a', title: 'Alpha' }),
  makeResult({ id: 'b', title: 'Beta' }),
]

function renderPanel() {
  const client = new QueryClient()
  const utils = render(
    <QueryClientProvider client={client}>
      <SidebarSearch />
    </QueryClientProvider>,
  )
  return utils
}

beforeEach(() => {
  vi.resetAllMocks()
  useUIStore.setState({
    activeFolder: null,
    searchMode: 'content',
    pendingMatch: null,
    residentSearchCollapsed: false,
    activeDocumentId: null,
  })
  ;(window as any).api = {
    search: {
      query: vi
        .fn()
        .mockImplementation((_q: string, opts: { mode?: string }) =>
          Promise.resolve(opts.mode === 'filename' ? fileResults : contentResults),
        ),
    },
    clipboard: { writeText: vi.fn() },
  }
})

describe('SidebarSearch (Phase 4 resident panel)', () => {
  it('is expanded by default and can be collapsed / expanded via the header', () => {
    renderPanel()
    expect(screen.getByTestId('resident-search-collapse')).toBeTruthy()
    expect(screen.getByTestId('resident-search-input')).toBeTruthy()
    // The query field is wrapped in a bordered, filled container so it reads as a field; it used to
    // be a bare transparent input. jsdom cannot verify the visual styling (the e2e asserts the
    // computed border/background), so lock the structural wrapper here.
    const box = screen.getByTestId('resident-search-box')
    expect(box.contains(screen.getByTestId('resident-search-input'))).toBe(true)
    // §3.4: the field row is icon + input + clear + an Esc hint. The chip must carry an
    // explanation — on its own a bare "Esc" would be an unlabelled key name. (That Esc really does
    // collapse the panel is asserted in the navigation-keys test below.)
    const esc = screen.getByTestId('resident-search-esc')
    expect(box.contains(esc)).toBe(true)
    expect(esc.textContent).toBe('Esc')
    expect(esc.getAttribute('title')).toBeTruthy()
    fireEvent.click(screen.getByTestId('resident-search-collapse'))
    expect(screen.getByTestId('resident-search-expand')).toBeTruthy()
    expect(screen.queryByTestId('resident-search-input')).toBeNull()
    fireEvent.click(screen.getByTestId('resident-search-expand'))
    expect(screen.getByTestId('resident-search-input')).toBeTruthy()
  })

  it('debounces the query and renders grouped hit rows from the IPC', async () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    const rows = await screen.findAllByTestId('search-match')
    expect(rows.length).toBe(3)
  })

  it('jumps the editor to the hit when a match row is clicked', async () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    const rows = await screen.findAllByTestId('search-match')
    fireEvent.click(rows[1])
    const pm = useUIStore.getState().pendingMatch
    expect(pm).toEqual({ id: 'a', start: 20, end: 23 })
    expect(useUIStore.getState().activeDocumentId).toBe('a')
  })

  it('opens the document (no jump) when a file row is clicked in file-name mode', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('search-mode-filename'))
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'Alpha' } })
    const rows = await screen.findAllByTestId('search-result')
    fireEvent.click(rows[0])
    expect(useUIStore.getState().activeDocumentId).toBe('a')
    expect(useUIStore.getState().pendingMatch).toBeNull()
  })

  it('navigation keys move the selection and Enter jumps; Escape collapses', async () => {
    renderPanel()
    const input = screen.getByTestId('resident-search-input')
    fireEvent.change(input, { target: { value: 'the' } })
    await screen.findAllByTestId('search-match')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Enter on the first hit jumps to it.
    expect(useUIStore.getState().pendingMatch).toEqual({ id: 'a', start: 0, end: 3 })
    // A fresh Escape collapses the panel.
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useUIStore.getState().residentSearchCollapsed).toBe(true)
  })

  it('clears the query with the X button', async () => {
    renderPanel()
    const input = screen.getByTestId('resident-search-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'the' } })
    await screen.findAllByTestId('search-match')
    fireEvent.click(screen.getByLabelText('Close Find'))
    expect(input.value).toBe('')
  })

  it('Enter on a file row in file-name mode opens the document without jumping', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('search-mode-filename'))
    const input = screen.getByTestId('resident-search-input')
    fireEvent.change(input, { target: { value: 'Alpha' } })
    await screen.findAllByTestId('search-result')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useUIStore.getState().activeDocumentId).toBe('a')
    expect(useUIStore.getState().pendingMatch).toBeNull()
  })

  it('ignores Enter with no results and unrelated keys', () => {
    renderPanel()
    const input = screen.getByTestId('resident-search-input')
    // No query -> no nav items; Enter and an unrelated key are both no-ops.
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'a' })
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })

  it('keeps its own search mode: flipping it never touches the Ctrl/Cmd+K palette mode', async () => {
    // The store's `searchMode` belongs to the modal; the resident panel holds its own.
    useUIStore.getState().setSearchMode('filename')
    renderPanel()
    fireEvent.click(screen.getByTestId('search-mode-content'))
    expect(useUIStore.getState().searchMode).toBe('filename')
    // And the resident panel really is in content mode: it renders grouped hits.
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    await screen.findAllByTestId('search-match')
    expect(useUIStore.getState().searchMode).toBe('filename')
  })

  it('exposes the All-documents scope toggle when a folder is active', async () => {
    useUIStore.setState({ activeFolder: 'work' })
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    await screen.findAllByTestId('search-match')
    // Toggle to All documents: the next query is scoped to null (whole workspace).
    const querySpy = (window as any).api.search.query as ReturnType<typeof vi.fn>
    querySpy.mockClear()
    fireEvent.click(screen.getByTestId('search-scope-all'))
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'fox' } })
    // Wait until the *toggled* query (scopeFolder: null) has actually fired.
    await waitFor(() => {
      const calls = querySpy.mock.calls
      expect(calls[calls.length - 1][1].scopeFolder).toBeNull()
    })
  })
})
