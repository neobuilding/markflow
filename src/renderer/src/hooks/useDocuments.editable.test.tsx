import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useUIStore } from '../store/ui'
import { useOpenPaths, useCreateDocument } from './useDocuments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fakeDocs: Record<string, { id: string; title: string; content: string; filePath: string; encoding: string; updatedAt: number; wordCount: number }> = {
  a: { id: 'a', title: 'A', content: '# A', filePath: '/a.md', encoding: 'utf-8', updatedAt: 1, wordCount: 1 },
  b: { id: 'b', title: 'B', content: '# B', filePath: '/b.md', encoding: 'utf-8', updatedAt: 2, wordCount: 1 },
}

function mountHook<T>(useHook: () => T): { result: { current: T }; root: ReturnType<typeof createRoot>; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  let value!: T
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  act(() => {
    root.render(
      <Wrapper>
        <HookCapture useHook={useHook} onValue={(v) => (value = v)} />
      </Wrapper>,
    )
  })
  return { result: { get current() { return value } }, root, container }
}

function HookCapture({ useHook, onValue }: { useHook: () => unknown; onValue: (v: unknown) => void }) {
  const v = useHook()
  onValue(v)
  return null
}

beforeEach(() => {
  const api = {
    files: { resolvePaths: vi.fn(async (paths: string[]) => ({ directories: ['/dir'], markdownFiles: paths })) },
    documents: {
      importMany: vi.fn(async (paths: string[]) =>
        paths.map((p) => (p === '/b.md' ? fakeDocs.b : fakeDocs.a)),
      ),
      create: vi.fn(async () => ({ id: 'new', title: 'Untitled', content: '', filePath: '', encoding: 'utf-8', updatedAt: 3, wordCount: 0 })),
      get: vi.fn(async (id: string) => fakeDocs[id]),
      eol: vi.fn(async () => '\n'),
      watch: vi.fn(async () => {}),
      unwatch: vi.fn(async () => {}),
      list: vi.fn(async () => Object.values(fakeDocs)),
    },
    menu: { setEditable: vi.fn(), setHasDocument: vi.fn() },
  }
  ;(window as unknown as { api: typeof api }).api = api
  useUIStore.getState().setActiveDocumentId(null)
  useUIStore.getState().setEditable(false)
  useUIStore.getState().setActiveFolder(null)
})

describe('editable mode — switching files always returns to read-only', () => {
  it('opening a file is read-only', async () => {
    const { result } = mountHook(() => useOpenPaths())
    const openPaths = result.current
    await act(async () => {
      await openPaths.mutateAsync(['/a.md'])
    })
    expect(useUIStore.getState().editable).toBe(false)
  })

  it('editing A, then switching to B via openPaths -> B is read-only again', async () => {
    const { result } = mountHook(() => useOpenPaths())
    const openPaths = result.current
    await act(async () => {
      await openPaths.mutateAsync(['/a.md'])
    })
    act(() => useUIStore.getState().toggleEditable())
    expect(useUIStore.getState().editable).toBe(true)

    await act(async () => {
      await openPaths.mutateAsync(['/b.md'])
    })
    // Switching documents must reset to read-only.
    expect(useUIStore.getState().editable).toBe(false)
    expect(useUIStore.getState().activeDocumentId).toBe('b')
  })

  it('creating a new document is editable', async () => {
    const { result } = mountHook(() => useCreateDocument())
    const create = result.current
    const doc = await act(async () => {
      return await create.mutateAsync({ title: 'Untitled' })
    })
    // The real callers (Sidebar/NewDocumentDialog) do this right after create:
    act(() => {
      useUIStore.getState().setActiveDocumentId(doc!.id)
      useUIStore.getState().setEditable(true)
    })
    expect(useUIStore.getState().activeDocumentId).toBe('new')
    // New documents opt back into edit mode.
    expect(useUIStore.getState().editable).toBe(true)
  })

  it('switching away from a new doc then back returns to read-only', async () => {
    const { result } = mountHook(() => useCreateDocument())
    const create = result.current
    const doc = await act(async () => {
      return await create.mutateAsync({ title: 'Untitled' })
    })
    act(() => {
      useUIStore.getState().setActiveDocumentId(doc!.id)
      useUIStore.getState().setEditable(true)
    })
    expect(useUIStore.getState().editable).toBe(true)
    // Switch to an opened file -> read-only
    const { result: openRes } = mountHook(() => useOpenPaths())
    const openPaths = openRes.current
    await act(async () => {
      await openPaths.mutateAsync(['/b.md'])
    })
    expect(useUIStore.getState().editable).toBe(false)
  })
})
