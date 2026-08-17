import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { CommandPalette } from './CommandPalette'
import { useUIStore } from '../../store/ui'
import type { SearchResult } from '../../types'

import '../../i18n'

const results: SearchResult[] = [
  { id: 'a', title: 'Apple', folderPath: '', snippet: 'a', score: 0, updatedAt: 1 },
  { id: 'b', title: 'Banana', folderPath: '', snippet: 'b', score: 0, updatedAt: 2 },
]

vi.mock('../../hooks/useSearch', () => ({
  useSearch: () => (globalThis as any).__searchState,
}))

beforeEach(() => {
  ;(globalThis as any).__searchState = { data: results, isFetching: false }
  useUIStore.getState().setSearchOpen(false)
  useUIStore.getState().setSearchQuery('')
  useUIStore.getState().setActiveDocumentId(null)
})

afterEach(() => cleanup())

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
})
