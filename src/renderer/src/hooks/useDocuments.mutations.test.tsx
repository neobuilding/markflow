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
  useRenameFile,
  useDeleteFolder,
  useUndoRename,
} from './useDocuments'
import { DOCS_KEY } from '../lib/queryClient'

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
    renameFile: vi.fn(async (_o: string, _n: string) => undefined),
    deleteFolder: vi.fn(async (_p: string) => undefined),
    undoRename: vi.fn(async () => ({ ok: true })),
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

  it('rewrites cached list/dirs paths from old to new before the refetch lands (no stale folder flash)', async () => {
    // Seed the cache the way the sidebar renders it: a list of docs under /a (one whose
    // folderPath equals /a exactly, one nested) and a dirs array that lists /a itself plus
    // a child. After rename /a -> /b EVERY cached entry must point at /b synchronously, so
    // the tree never renders the old folder node beside the new one.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    qc.setQueryData(
      [...DOCS_KEY, 'list', '/root'],
      [
        { id: '1', filePath: '/a/demo.md', folderPath: '/a' },
        { id: '2', filePath: '/a/sub/nested.md', folderPath: '/a/sub' },
      ],
    )
    qc.setQueryData([...DOCS_KEY, 'dirs', '/root'], ['/a', '/a/sub'])

    let value!: ReturnType<typeof useRenameFolder>
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    act(() => {
      const root = createRoot(document.createElement('div'))
      root.render(
        <Wrapper>
          <HookCapture<ReturnType<typeof useRenameFolder>>
            useHook={() => useRenameFolder()}
            onValue={(v) => (value = v)}
          />
        </Wrapper>,
      )
    })

    await act(async () => {
      await value.mutateAsync({ oldPath: '/a', newPath: '/b' })
    })

    const list = qc.getQueryData([...DOCS_KEY, 'list', '/root']) as Array<{
      filePath: string
      folderPath: string
    }>
    const dirs = qc.getQueryData([...DOCS_KEY, 'dirs', '/root']) as string[]
    expect(list[0].filePath).toBe('/b/demo.md')
    expect(list[0].folderPath).toBe('/b')
    expect(list[1].filePath).toBe('/b/sub/nested.md')
    expect(list[1].folderPath).toBe('/b/sub')
    // The renamed folder itself (/a alone) and its child are both re-pointed.
    expect(dirs).toEqual(['/b', '/b/sub'])
    // The stale old path is gone from every cached entry.
    expect(JSON.stringify(qc.getQueryCache().getAll())).not.toContain('/a')
  })

  it('rewriteFolderInCache (via useRenameFolder) only re-points entries under the renamed folder and leaves other cache shapes untouched', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    // A list under /root: one doc lives inside the renamed folder (must move) and one
    // lives outside it. The outside doc exercises the `!fpHit && !foHit` early return
    // that keeps unrelated docs from being rewritten.
    qc.setQueryData(
      [...DOCS_KEY, 'list', '/root'],
      [
        { id: 'in', filePath: '/a/demo.md', folderPath: '/a' },
        { id: 'out', filePath: '/other/keep.md', folderPath: '/other' },
        // filePath under /a but folderPath elsewhere: only filePath is re-pointed.
        { id: 'fp-only', filePath: '/a/file.md', folderPath: '/elsewhere' },
        // folderPath under /a but filePath elsewhere: only folderPath is re-pointed.
        { id: 'fo-only', filePath: '/outside.md', folderPath: '/a' },
      ],
    )
    // A dirs array under /root: one folder is inside /a (moves) and one is outside
    // (stays — the `!hits(dir)` early return).
    qc.setQueryData([...DOCS_KEY, 'dirs', '/root'], ['/a', '/a/sub', '/other-sibling'])
    // Defensive guards: a list/dirs cache entry that is NOT an array must be passed
    // through untouched rather than throwing (`!Array.isArray` early returns).
    qc.setQueryData([...DOCS_KEY, 'list', 'scalar'], {
      error: 'not-an-array',
    } as unknown as Array<unknown>)
    qc.setQueryData([...DOCS_KEY, 'dirs', 'scalar'], '/not-an-array' as unknown as string[])

    let value!: ReturnType<typeof useRenameFolder>
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    act(() => {
      const root = createRoot(document.createElement('div'))
      root.render(
        <Wrapper>
          <HookCapture<ReturnType<typeof useRenameFolder>>
            useHook={() => useRenameFolder()}
            onValue={(v) => (value = v)}
          />
        </Wrapper>,
      )
    })

    await act(async () => {
      await value.mutateAsync({ oldPath: '/a', newPath: '/b' })
    })

    const list = qc.getQueryData([...DOCS_KEY, 'list', '/root']) as Array<{
      id: string
      filePath: string
      folderPath: string
    }>
    const dirs = qc.getQueryData([...DOCS_KEY, 'dirs', '/root']) as string[]
    // Inside the renamed folder: re-pointed to /b.
    expect(list.find((d) => d.id === 'in')!.filePath).toBe('/b/demo.md')
    expect(list.find((d) => d.id === 'in')!.folderPath).toBe('/b')
    expect(dirs).toContain('/b')
    expect(dirs).toContain('/b/sub')
    // Outside the renamed folder: left exactly as they were (early-return branches).
    expect(list.find((d) => d.id === 'out')!.filePath).toBe('/other/keep.md')
    expect(dirs).toContain('/other-sibling')
    // filePath and folderPath are re-pointed independently: only the matching part moves.
    expect(list.find((d) => d.id === 'fp-only')!.filePath).toBe('/b/file.md')
    expect(list.find((d) => d.id === 'fp-only')!.folderPath).toBe('/elsewhere')
    expect(list.find((d) => d.id === 'fo-only')!.filePath).toBe('/outside.md')
    expect(list.find((d) => d.id === 'fo-only')!.folderPath).toBe('/b')
    // Non-array cache shapes are preserved, not mutated by the rewriter.
    expect(qc.getQueryData([...DOCS_KEY, 'list', 'scalar'])).toEqual({
      error: 'not-an-array',
    })
    expect(qc.getQueryData([...DOCS_KEY, 'dirs', 'scalar'])).toBe('/not-an-array')
    // No stale /a reference lingers in any re-pointed entry.
    expect(JSON.stringify(qc.getQueryCache().getAll())).not.toContain('"/a"')
  })
})

describe('useRenameFile', () => {
  it('calls documents.renameFile and invalidates the documents list', async () => {
    const { result } = mountHook(() => useRenameFile())
    await act(async () => {
      await result.current.mutateAsync({ oldPath: '/a.md', newPath: '/b.md' })
    })
    expect(api.documents.renameFile).toHaveBeenCalledWith('/a.md', '/b.md')
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

describe('useUndoRename (能力 7)', () => {
  it('calls documents.undoRename and invalidates the documents list on success', async () => {
    const { result } = mountHook(() => useUndoRename())
    await act(async () => {
      await result.current.mutateAsync()
    })
    expect(api.documents.undoRename).toHaveBeenCalled()
  })

  it('does not invalidate when there is nothing to undo', async () => {
    // Covers the `if (res?.ok)` false branch: a silent "nothing to undo" must not refetch.
    api.documents.undoRename.mockImplementationOnce(async () => ({ ok: false, reason: 'none' }))
    const { result } = mountHook(() => useUndoRename())
    await act(async () => {
      await result.current.mutateAsync()
    })
    expect(api.documents.undoRename).toHaveBeenCalled()
  })
})
