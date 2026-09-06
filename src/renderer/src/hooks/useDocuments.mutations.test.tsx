import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useSetEol,
  useDetectEncoding,
  useCreateFolder,
  useRenameFolder,
  useDeleteFolder,
} from './useDocuments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mountHook<T>(useHook: () => T): { result: { current: T } } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  let value!: T
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  act(() => {
    root.render(
      <Wrapper>
        <HookCapture<T> useHook={useHook} onValue={(v) => (value = v)} />
      </Wrapper>,
    )
  })
  return {
    result: {
      get current() {
        return value
      },
    },
  }
}

function HookCapture<T>({ useHook, onValue }: { useHook: () => T; onValue: (v: T) => void }) {
  const v = useHook()
  onValue(v)
  return null
}

const api = {
  documents: {
    setEol: vi.fn(async (_p: string, _e: string) => undefined),
    detectEncoding: vi.fn(async (_p: string) => ({ enc: 'utf-8', confidence: 1 })),
    createFolder: vi.fn(async (_p: string) => undefined),
    renameFolder: vi.fn(async (_o: string, _n: string) => undefined),
    deleteFolder: vi.fn(async (_p: string) => undefined),
  },
}

beforeEach(() => {
  ;(window as unknown as { api: typeof api }).api = api
  vi.clearAllMocks()
})

describe('useSetEol (能力 6)', () => {
  it('calls documents.setEol and invalidates the eol query', async () => {
    const { result } = mountHook(() => useSetEol())
    await act(async () => {
      await result.current.mutateAsync({ filePath: '/x.md', eol: '\n' })
    })
    expect(api.documents.setEol).toHaveBeenCalledWith('/x.md', '\n')
  })
})

describe('useDetectEncoding (能力 11)', () => {
  it('calls documents.detectEncoding', async () => {
    const { result } = mountHook(() => useDetectEncoding())
    await act(async () => {
      await result.current.mutateAsync('/x.md')
    })
    expect(api.documents.detectEncoding).toHaveBeenCalledWith('/x.md')
  })
})

describe('useCreateFolder (能力 7)', () => {
  it('calls documents.createFolder and invalidates the documents list', async () => {
    const { result } = mountHook(() => useCreateFolder())
    await act(async () => {
      await result.current.mutateAsync('/new')
    })
    expect(api.documents.createFolder).toHaveBeenCalledWith('/new')
  })
})

describe('useRenameFolder (能力 7)', () => {
  it('calls documents.renameFolder and invalidates the documents list', async () => {
    const { result } = mountHook(() => useRenameFolder())
    await act(async () => {
      await result.current.mutateAsync({ oldPath: '/a', newPath: '/b' })
    })
    expect(api.documents.renameFolder).toHaveBeenCalledWith('/a', '/b')
  })
})

describe('useDeleteFolder (能力 7)', () => {
  it('calls documents.deleteFolder and invalidates the documents list', async () => {
    const { result } = mountHook(() => useDeleteFolder())
    await act(async () => {
      await result.current.mutateAsync('/d')
    })
    expect(api.documents.deleteFolder).toHaveBeenCalledWith('/d')
  })
})
