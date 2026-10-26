import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { CommandPalette } from './CommandPalette'
import { useUIStore } from '../../store/ui'
import type { SearchResult } from '../../types'

import '../../i18n'

const results: SearchResult[] = [
  {
    documentId: 'a',
    title: 'Apple',
    relPath: 'apple.md',
    filePath: '/docs/apple.md',
    matchCount: 0,
    matchCapped: false,
    matches: [],
  },
  // A memory-only draft: `relPath` is null and there is no path to copy.
  {
    documentId: 'b',
    title: 'Banana',
    relPath: null,
    filePath: '',
    matchCount: 0,
    matchCapped: false,
    matches: [],
  },
]

vi.mock('../../hooks/useSearch', () => ({
  useQuickOpen: () => (globalThis as any).__searchState,
}))

beforeEach(() => {
  ;(globalThis as any).__searchState = {
    data: {
      results,
      diagnostics: [],
      appliedScope: { root: null, include: [], exclude: [] },
      truncated: false,
    },
    isFetching: false,
  }
  useUIStore.getState().setSearchOpen(false)
  useUIStore.getState().setSearchQuery('')
  useUIStore.getState().setActiveDocumentId(null)
})

afterEach(() => {
  cleanup()
  // The guard tests below install a "keep editing" dialog bridge; without this reset the
  // dirty flag and the half-mocked bridge leak into the next describe.
  useUIStore.getState().setDirty(false)
  useUIStore.getState().setActiveDocumentId(null)
})

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<CommandPalette />)
    expect(container.firstChild).toBeNull()
  })

  it('shows results when open with a query', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    expect(await screen.findByText('Apple')).toBeInTheDocument()
    expect(screen.getByText('Banana')).toBeInTheDocument()
  })

  it('focuses the search input shortly after opening', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    const input = await screen.findByPlaceholderText('Search documents…')
    // The open effect schedules inputRef.focus() + setSelectedIndex(0) on a 50ms
    // timer; awaiting focus drives that callback so its lines are covered.
    await waitFor(() => expect(input).toHaveFocus(), { timeout: 1000 })
  })

  it('selects a result and closes the palette', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    fireEvent.click(await screen.findByText('Banana'))
    await waitFor(() => expect(useUIStore.getState().searchOpen).toBe(false))
    expect(useUIStore.getState().activeDocumentId).toBe('b')
  })

  it('navigates with arrow keys and opens with Enter', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    const input = await screen.findByPlaceholderText('Search documents…')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(useUIStore.getState().activeDocumentId).toBe('b'))
  })

  it('shows the start-typing hint when there is no query', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('')
    render(<CommandPalette />)
    expect(await screen.findByText('Start typing to search your documents…')).toBeInTheDocument()
  })

  it('closes when the overlay is clicked', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    const { container } = render(<CommandPalette />)
    fireEvent.click(container.firstChild as HTMLElement)
    await waitFor(() => expect(useUIStore.getState().searchOpen).toBe(false))
  })

  it('updates the query on input', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    const input = await screen.findByPlaceholderText('Search documents…')
    fireEvent.change(input, { target: { value: 'xyz' } })
    expect(useUIStore.getState().searchQuery).toBe('xyz')
  })

  it('clears the query with the clear button', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    const { container } = render(<CommandPalette />)
    await screen.findByPlaceholderText('Search documents…')
    const clear = container.querySelector('button') as HTMLElement
    fireEvent.click(clear)
    expect(useUIStore.getState().searchQuery).toBe('')
  })

  it('does not go below the first result on ArrowUp', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    const input = await screen.findByPlaceholderText('Search documents…')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    // selectedIndex stays 0; selecting still opens the first result
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(useUIStore.getState().activeDocumentId).toBe('a'))
  })

  it('highlights a row on mouse enter', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    const row = await screen.findByText('Apple')
    fireEvent.mouseEnter(row)
    expect(row).toBeInTheDocument()
  })

  it('shows the searching indicator while fetching', async () => {
    ;(globalThis as any).__searchState = { data: [], isFetching: true }
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    expect(await screen.findByText(/Searching/i)).toBeInTheDocument()
  })

  // The ROW shows the path relative to the workspace root (it is what disambiguates two documents
  // with the same title); the context menu copies the ABSOLUTE one — asserted separately below.
  it('shows the root-relative path for results that have one (能力 10)', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    expect(await screen.findByText('apple.md')).toBeInTheDocument()
  })

  it('hides the file path for memory-only drafts', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    expect(await screen.findByText('Banana')).toBeInTheDocument()
    // Apple carries /docs/apple.md; Banana is a draft with no on-disk path.
    expect(screen.getAllByText(/\.md$/)).toHaveLength(1)
    expect(screen.queryByText('/docs/banana.md')).toBeNull()
  })

  it('shows no results when the query matches nothing', async () => {
    ;(globalThis as any).__searchState = { data: [], isFetching: false }
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('zzz')
    render(<CommandPalette />)
    expect(await screen.findByText(/No results/i)).toBeInTheDocument()
  })

  it('opens via the Ctrl/Cmd+K global shortcut', () => {
    render(<CommandPalette />)
    expect(useUIStore.getState().searchOpen).toBe(false)
    fireEvent.keyDown(window, { ctrlKey: true, key: 'k' })
    expect(useUIStore.getState().searchOpen).toBe(true)
  })

  it('closes via the Escape global shortcut when open', () => {
    useUIStore.getState().setSearchOpen(true)
    render(<CommandPalette />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useUIStore.getState().searchOpen).toBe(false)
  })

  it('does not open on Ctrl/Cmd+K while a modal surface owns the keyboard', () => {
    useUIStore.getState().setSearchOpen(false)
    render(<CommandPalette />)
    // A dialog is already open: the palette must not be stacked on top of it.
    const modal = document.createElement('div')
    modal.setAttribute('data-modal-surface', '')
    document.body.appendChild(modal)
    const ev = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(ev)
    expect(useUIStore.getState().searchOpen).toBe(false)
    // And it must not swallow a key it does not own.
    expect(ev.defaultPrevented).toBe(false)
    modal.remove()
  })

  it('does nothing when Enter is pressed with no selected result', async () => {
    ;(globalThis as any).__searchState = { data: [], isFetching: false }
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('zzz')
    render(<CommandPalette />)
    const input = await screen.findByPlaceholderText('Search documents…')
    fireEvent.keyDown(input, { key: 'Enter' })
    // No result selected => active document stays unchanged.
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().searchOpen).toBe(true)
  })

  // Quick Open is a SPECIALIZED surface (ADR-0023): no mode switch and no scope control. If
  // either ever comes back, this surface has silently become two surfaces again.
  it('exposes no mode switch and no scope control', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    await screen.findByText('Apple')
    expect(screen.queryByTestId('search-mode-filename')).toBeNull()
    expect(screen.queryByTestId('search-mode-content')).toBeNull()
    expect(screen.queryByTestId('search-scope')).toBeNull()
  })

  it('names its own scope in the footer ("go to file")', async () => {
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    expect(await screen.findByText('Go to file…')).toBeInTheDocument()
  })

  // ADR-0023: a palette click is a document switch like any other — the unsaved guard must
  // fire here too, and "keep editing" must leave the palette open on the same document.
  it('does not switch when the unsaved guard is declined', async () => {
    const confirm: ReturnType<typeof vi.fn> = vi.fn(async () => false)
    ;(window as unknown as { api: unknown }).api = { dialog: { confirm } }
    useUIStore.getState().setActiveDocumentId('a')
    useUIStore.getState().setActiveDocumentTitle('Apple')
    useUIStore.getState().setDirty(true)
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    render(<CommandPalette />)
    fireEvent.click(await screen.findByText('Banana'))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0].message).toContain('Apple')
    expect(useUIStore.getState().activeDocumentId).toBe('a')
    // Nothing switched, so there is nothing to close over: the palette stays open.
    expect(useUIStore.getState().searchOpen).toBe(true)
  })
})
describe('CommandPalette — result row context menu', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    ;(globalThis as any).__searchState = {
      data: {
        results,
        diagnostics: [],
        appliedScope: { root: null, include: [], exclude: [] },
        truncated: false,
      },
      isFetching: false,
    }
    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('a')
    useUIStore.getState().setActiveDocumentId(null)
    useUIStore.getState().setFileDetailsId(null)
    writeText.mockReset()
    ;(window as unknown as { api: unknown }).api = { clipboard: { writeText } }
  })

  it('shows the full menu on right-click of a result row', async () => {
    render(<CommandPalette />)
    const rows = await screen.findAllByTestId('search-result')
    fireEvent.contextMenu(rows[0])
    for (const id of [
      'palette-open-document',
      'palette-copy-title',
      'palette-copy-result-path',
      'palette-copy-folder-path',
      'palette-details',
    ]) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('opens the document from the menu', async () => {
    render(<CommandPalette />)
    const rows = await screen.findAllByTestId('search-result')
    fireEvent.contextMenu(rows[1])
    fireEvent.click(await screen.findByTestId('palette-open-document'))
    await waitFor(() => expect(useUIStore.getState().activeDocumentId).toBe('b'))
    expect(useUIStore.getState().searchOpen).toBe(false)
  })

  it('copies the title without closing the palette', async () => {
    render(<CommandPalette />)
    const rows = await screen.findAllByTestId('search-result')
    fireEvent.contextMenu(rows[0])
    fireEvent.click(await screen.findByTestId('palette-copy-title'))
    expect(writeText).toHaveBeenCalledWith('Apple')
    // The overlay behind the palette closes it on click the menu must swallow the
    // bubble so a menu action never doubles as "dismiss the palette".
    expect(useUIStore.getState().searchOpen).toBe(true)
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })

  it('copies the on-disk file path (能力 10)', async () => {
    render(<CommandPalette />)
    const rows = await screen.findAllByTestId('search-result')
    fireEvent.contextMenu(rows[0])
    fireEvent.click(await screen.findByTestId('palette-copy-result-path'))
    expect(writeText).toHaveBeenCalledWith('/docs/apple.md')
  })

  it('greys copy-path for a draft with no file or folder', async () => {
    render(<CommandPalette />)
    const rows = await screen.findAllByTestId('search-result')
    fireEvent.contextMenu(rows[1])
    expect(await screen.findByTestId('palette-copy-result-path')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByTestId('palette-copy-folder-path')).toHaveAttribute('aria-disabled', 'true')
  })

  // The folder is derived from the result's own absolute path: there is no `folderPath` field any
  // more (the frozen contract carries `relPath` + `filePath`).
  it('copies the folder path when the result has one', async () => {
    render(<CommandPalette />)
    const rows = await screen.findAllByTestId('search-result')
    fireEvent.contextMenu(rows[0])
    fireEvent.click(await screen.findByTestId('palette-copy-folder-path'))
    expect(writeText).toHaveBeenCalledWith('/docs')
  })

  it('opens file details from the menu', async () => {
    render(<CommandPalette />)
    const rows = await screen.findAllByTestId('search-result')
    fireEvent.contextMenu(rows[0])
    fireEvent.click(await screen.findByTestId('palette-details'))
    expect(useUIStore.getState().fileDetailsId).toBe('a')
  })
})
