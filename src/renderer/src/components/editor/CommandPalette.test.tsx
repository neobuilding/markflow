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
  useSearch: () => ({ data: results, isFetching: false }),
}))

beforeEach(() => {
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
})
