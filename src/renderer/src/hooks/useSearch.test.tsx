import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSearch } from './useSearch'
import { useUIStore } from '../store/ui'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = {
  search: { query: vi.fn() },
}
beforeEach(() => {
  vi.resetAllMocks()
  ;(window as unknown as { api: unknown }).api = api
  ;(globalThis as unknown as { api: unknown }).api = api
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

describe('useSearch', () => {
  it('queries the search api with the current query when non-empty', () => {
    act(() => useUIStore.getState().setSearchQuery('hello'))
    api.search.query.mockResolvedValue([])
    renderHook(() => useSearch())
    expect(api.search.query).toHaveBeenCalledWith('hello')
  })

  it('does not query when the search query is empty', () => {
    act(() => useUIStore.getState().setSearchQuery(''))
    renderHook(() => useSearch())
    expect(api.search.query).not.toHaveBeenCalled()
  })
})
