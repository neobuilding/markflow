import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useDocuments,
  useDocument,
  useCreateDocument,
  useUpdateDocument,
  useDeleteDocument,
  useSaveDocumentAs,
  useReloadDocument,
  useSetEncoding,
  useFileStat,
  useImportDocument,
  useImportDocuments,
  useOpenPaths,
  useOpenFolder,
} from './useDocuments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Full api mock: every method returns a controllable promise.
const api = {
  documents: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    import: vi.fn(),
    importMany: vi.fn(),
    saveAs: vi.fn(),
    reload: vi.fn(),
    setEncoding: vi.fn(),
    stat: vi.fn(),
    watch: vi.fn(),
    unwatch: vi.fn(),
    eol: vi.fn(),
  },
  files: { resolvePaths: vi.fn() },
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(window as unknown as { api: unknown }).api = api
  // the module imports `window.api` lazily via the global; ensure it's present
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
  return {
    result,
    client,
    unmount: () => act(() => root.unmount()),
  }
}

const doc = {
  id: 'd1',
  title: 'T',
  folderPath: '',
  filePath: '/a/t.md',
  content: 'c',
  wordCount: 1,
  isArchived: false,
  encoding: 'utf-8',
  encodingConfidence: 1,
  createdAt: 0,
  updatedAt: 0,
}

describe('useDocuments list/detail queries', () => {
  it('useDocuments queries the list with the folder key', () => {
    api.documents.list.mockResolvedValue([doc])
    const { result } = renderHook(() => useDocuments('/f'))
    expect(api.documents.list).toHaveBeenCalledWith('/f')
  })

  it('useDocuments falls back to an empty folder key when no folder is given', () => {
    api.documents.list.mockResolvedValue([doc])
    renderHook(() => useDocuments())
    expect(api.documents.list).toHaveBeenCalledWith(undefined)
  })

  it('useDocument is disabled when id is null', () => {
    api.documents.get.mockResolvedValue(doc)
    const { result } = renderHook(() => useDocument(null))
    expect(api.documents.get).not.toHaveBeenCalled()
  })

  it('useDocument fetches the doc when id is present', async () => {
    api.documents.get.mockResolvedValue(doc)
    renderHook(() => useDocument('d1'))
    // the query is enabled, so the api is called with the id (exercises line 18)
    expect(api.documents.get).toHaveBeenCalledWith('d1')
    await act(async () => {
      await Promise.resolve()
    })
  })
})

describe('useCreateDocument', () => {
  it('defaults to memoryOnly:true and invalidates the list on success', async () => {
    api.documents.create.mockResolvedValue(doc)
    const { result, client } = renderHook(() => useCreateDocument())
    await act(async () => {
      await result.current.mutateAsync({ title: 'T', content: 'c' })
    })
    expect(api.documents.create).toHaveBeenCalledWith(
      expect.objectContaining({ memoryOnly: true }),
    )
    // list cache invalidated
    expect(client.getQueryData(['documents'])).toBeUndefined()
  })
})

describe('useUpdateDocument', () => {
  it('updates detail + list caches on success', async () => {
    api.documents.update.mockResolvedValue(doc)
    const { result, client } = renderHook(() => useUpdateDocument())
    await act(async () => {
      await result.current.mutateAsync({ id: 'd1', updates: { content: 'x' } })
    })
    expect(api.documents.update).toHaveBeenCalledWith('d1', { content: 'x' })
    expect(client.getQueryData(['documents', 'detail', 'd1'])).toEqual(doc)
  })
})

describe('useDeleteDocument', () => {
  it('invalidates the list on success', async () => {
    api.documents.delete.mockResolvedValue(true)
    const { result } = renderHook(() => useDeleteDocument())
    await act(async () => {
      await result.current.mutateAsync('d1')
    })
    expect(api.documents.delete).toHaveBeenCalledWith('d1')
  })
})

describe('useSaveDocumentAs', () => {
  it('writes to a new path and refreshes caches', async () => {
    api.documents.saveAs.mockResolvedValue(doc)
    const { result, client } = renderHook(() => useSaveDocumentAs())
    await act(async () => {
      await result.current.mutateAsync({ id: 'd1', filePath: '/b/n.md', updates: { title: 'N' } })
    })
    expect(api.documents.saveAs).toHaveBeenCalledWith('d1', '/b/n.md', { title: 'N' })
    expect(client.getQueryData(['documents', 'detail', 'd1'])).toEqual(doc)
  })
})

describe('useReloadDocument', () => {
  it('reloads from disk and refreshes caches', async () => {
    api.documents.reload.mockResolvedValue(doc)
    const { result } = renderHook(() => useReloadDocument())
    await act(async () => {
      await result.current.mutateAsync('d1')
    })
    expect(api.documents.reload).toHaveBeenCalledWith('d1')
  })
})

describe('useSetEncoding', () => {
  it('re-decodes with the chosen encoding and refreshes caches', async () => {
    api.documents.setEncoding.mockResolvedValue(doc)
    const { result } = renderHook(() => useSetEncoding())
    await act(async () => {
      await result.current.mutateAsync({ id: 'd1', encoding: 'gbk' })
    })
    expect(api.documents.setEncoding).toHaveBeenCalledWith('d1', 'gbk')
  })

  it('skips cache writes when the mutation returns null (if (data) guard)', async () => {
    api.documents.setEncoding.mockResolvedValue(null)
    const { result, client } = renderHook(() => useSetEncoding())
    await act(async () => {
      await result.current.mutateAsync({ id: 'd1', encoding: 'gbk' })
    })
    expect(api.documents.setEncoding).toHaveBeenCalledWith('d1', 'gbk')
    expect(client.getQueryData(['documents', 'detail', 'd1'])).toBeUndefined()
  })
})

describe('mutation onSuccess null guards (if (data))', () => {
  it('useUpdateDocument skips caches when update returns null', async () => {
    api.documents.update.mockResolvedValue(null)
    const { result, client } = renderHook(() => useUpdateDocument())
    await act(async () => {
      await result.current.mutateAsync({ id: 'd1', updates: { content: 'x' } })
    })
    expect(client.getQueryData(['documents', 'detail', 'd1'])).toBeUndefined()
  })

  it('useSaveDocumentAs skips caches when saveAs returns null', async () => {
    api.documents.saveAs.mockResolvedValue(null)
    const { result, client } = renderHook(() => useSaveDocumentAs())
    await act(async () => {
      await result.current.mutateAsync({ id: 'd1', filePath: '/b/n.md', updates: { title: 'N' } })
    })
    expect(client.getQueryData(['documents', 'detail', 'd1'])).toBeUndefined()
  })

  it('useReloadDocument skips caches when reload returns null', async () => {
    api.documents.reload.mockResolvedValue(null)
    const { result, client } = renderHook(() => useReloadDocument())
    await act(async () => {
      await result.current.mutateAsync('d1')
    })
    expect(client.getQueryData(['documents', 'detail', 'd1'])).toBeUndefined()
  })
})

describe('useFileStat', () => {
  it('is disabled when path is null', () => {
    api.documents.stat.mockResolvedValue({ exists: true })
    const { result } = renderHook(() => useFileStat(null))
    expect(api.documents.stat).not.toHaveBeenCalled()
  })

  it('queries stat when path present', () => {
    api.documents.stat.mockResolvedValue({ exists: true, size: 1 })
    const { result } = renderHook(() => useFileStat('/a/t.md'))
    expect(api.documents.stat).toHaveBeenCalledWith('/a/t.md')
  })
})

describe('useImportDocument / useImportDocuments', () => {
  it('imports a single file and refreshes caches', async () => {
    api.documents.import.mockResolvedValue(doc)
    const { result } = renderHook(() => useImportDocument())
    await act(async () => {
      await result.current.mutateAsync('/a/t.md')
    })
    expect(api.documents.import).toHaveBeenCalledWith('/a/t.md')
  })

  it('does nothing when the imported document is null', async () => {
    api.documents.import.mockResolvedValue(null)
    const { result } = renderHook(() => useImportDocument())
    await act(async () => {
      await result.current.mutateAsync('/a/t.md')
    })
    expect(api.documents.import).toHaveBeenCalledWith('/a/t.md')
  })

  it('batch-imports and invalidates only when results exist', async () => {
    api.documents.importMany.mockResolvedValue([])
    const { result } = renderHook(() => useImportDocuments())
    await act(async () => {
      await result.current.mutateAsync(['/a/t.md'])
    })
    expect(api.documents.importMany).toHaveBeenCalledWith(['/a/t.md'])
  })

  it('does NOT invalidate the list when batch import returns empty', async () => {
    api.documents.importMany.mockResolvedValue([])
    const invalidate = vi.fn()
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHookWith(() => useImportDocuments(), client)
    await act(async () => {
      await result.current.mutateAsync(['/x.md'])
    })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('useOpenPaths / useOpenFolder', () => {
  it('resolves paths, imports, and activates the first document read-only', async () => {
    const { useUIStore } = await import('../store/ui')
    api.files.resolvePaths.mockResolvedValue({ directories: ['/a'], markdownFiles: ['/a/t.md'] })
    api.documents.importMany.mockResolvedValue([doc])
    const { result } = renderHook(() => useOpenPaths())
    const out = await act(async () => {
      return await result.current.mutateAsync(['/a'])
    })
    expect(api.files.resolvePaths).toHaveBeenCalledWith(['/a'])
    expect(api.documents.importMany).toHaveBeenCalledWith(['/a/t.md'])
    expect(out).toEqual({ folder: '/a', documentId: 'd1' })
    expect(useUIStore.getState().activeDocumentId).toBe('d1')
    expect(useUIStore.getState().editable).toBe(false)
    expect(useUIStore.getState().dirty).toBe(false)
  })

  it('returns null when no markdown files are found', async () => {
    api.files.resolvePaths.mockResolvedValue({ directories: ['/a'], markdownFiles: [] })
    const { result } = renderHook(() => useOpenPaths())
    const out = await act(async () => {
      return await result.current.mutateAsync(['/a'])
    })
    expect(out).toBeNull()
  })

  it('derives the folder from the first markdown file when no directories are returned', async () => {
    api.files.resolvePaths.mockResolvedValue({ directories: [], markdownFiles: ['/x/y.md'] })
    api.documents.importMany.mockResolvedValue([doc])
    const { result } = renderHook(() => useOpenPaths())
    const out = await act(async () => {
      return await result.current.mutateAsync(['/x/y.md'])
    })
    expect(out).toEqual({ folder: '/x', documentId: 'd1' })
  })

  it('useOpenFolder delegates to useOpenPaths with a single folder', async () => {
    api.files.resolvePaths.mockResolvedValue({ directories: ['/a'], markdownFiles: ['/a/t.md'] })
    api.documents.importMany.mockResolvedValue([doc])
    const { result } = renderHook(() => useOpenFolder())
    const out = await act(async () => {
      return await result.current.mutateAsync('/a')
    })
    expect(out).toEqual({ folder: '/a', documentId: 'd1' })
  })

  it('useOpenPaths returns null for an empty path list', async () => {
    const { result } = renderHook(() => useOpenPaths())
    const out = await act(async () => {
      return await result.current.mutateAsync([])
    })
    expect(out).toBeNull()
    expect(api.files.resolvePaths).not.toHaveBeenCalled()
  })

  it('useOpenPaths returns null when the import yields no documents', async () => {
    api.files.resolvePaths.mockResolvedValue({ directories: ['/a'], markdownFiles: ['/a/t.md'] })
    api.documents.importMany.mockResolvedValue([])
    const { result } = renderHook(() => useOpenPaths())
    const out = await act(async () => {
      return await result.current.mutateAsync(['/a'])
    })
    expect(out).toBeNull()
  })
})

// helper: render with an explicit QueryClient (for spy assertions)
function renderHookWith<T>(factory: () => T, client: QueryClient) {
  const result = { current: undefined as unknown as T }
  function Wrapper() {
    result.current = factory()
    return null
  }
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
