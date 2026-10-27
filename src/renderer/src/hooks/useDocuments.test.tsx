import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Document } from '../types'
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
import { useUIStore } from '../store/ui'

// Initialise i18next: without it `t()` (used by the open-path dialogs) returns undefined.
import '../i18n'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

const doc = (id: string): Document => ({
  id,
  title: `Doc ${id}`,
  folderPath: '/docs',
  filePath: `/docs/${id}.md`,
  content: 'body',
  wordCount: 1,
  encoding: 'utf-8',
  encodingConfidence: 1,
  createdAt: 1,
  updatedAt: 1,
})

const api = {
  documents: {
    list: vi.fn(async () => [doc('1')]),
    get: vi.fn(async (id: string) => doc(id)),
    create: vi.fn(async (args: unknown) => ({ id: 'new', ...(args as object) })),
    update: vi.fn(async (_id: string, _u: unknown): Promise<Document | null> => doc('1')),
    delete: vi.fn(async () => undefined),
    saveAs: vi.fn(async (_id: string, _p: string, _u: unknown): Promise<Document | null> =>
      doc('1'),
    ),
    reload: vi.fn(async (_id: string): Promise<Document | null> => doc('1')),
    setEncoding: vi.fn(async (_id: string, _e: string): Promise<Document | null> => doc('1')),
    stat: vi.fn(async () => ({ size: 1, created: 1, modified: 1 })),
    import: vi.fn(async (_p: string): Promise<Document | null> => doc('imp')),
    importMany: vi.fn(async (paths: string[]) => paths.map((p) => doc(p))),
    // Opening REPLACES the workspace (ADR-0023): one root, set in one call.
    setWorkspaceRoot: vi.fn(async (_root: string | null) => undefined),
  },
  files: {
    resolvePaths: vi.fn(async (paths: string[]) => ({ directories: paths, markdownFiles: paths })),
  },
  dialog: {
    // Used when several unrelated directories cannot converge on one root (D15), and to name
    // the new root when they DO converge. Wide mock type so tests can inspect the arguments.
    confirm: vi.fn(async () => true) as unknown as ReturnType<typeof vi.fn>,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = api
  useUIStore.getState().setActiveFolder(null)
  useUIStore.getState().setActiveDocumentId(null)
})

describe('useDocuments — list query', () => {
  it('lists documents for an explicit folder', async () => {
    const { result } = renderHook(() => useDocuments('/docs'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(api.documents.list).toHaveBeenCalledWith('/docs')
  })

  it('lists documents for the default (empty) folder when none is given', async () => {
    const { result } = renderHook(() => useDocuments(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(api.documents.list).toHaveBeenCalledWith(undefined)
  })
})

describe('useDocument — detail query', () => {
  it('does not query when id is null (enabled false)', async () => {
    const { result } = renderHook(() => useDocument(null), { wrapper: wrapper() })
    expect(result.current.fetchStatus).toBe('idle')
    expect(api.documents.get).not.toHaveBeenCalled()
  })

  it('queries the detail when id is provided', async () => {
    const { result } = renderHook(() => useDocument('7'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(api.documents.get).toHaveBeenCalledWith('7')
  })
})

describe('useCreateDocument — folder fallback', () => {
  it('falls back to undefined folderPath when activeFolder is null and no folderPath is given', async () => {
    const { result } = renderHook(() => useCreateDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ title: 'X' })
    })
    const call = api.documents.create.mock.calls[0][0] as {
      folderPath?: string
      memoryOnly?: boolean
    }
    expect(call.folderPath).toBeUndefined()
    expect(call.memoryOnly).toBe(true) // default draft is memory-only
  })

  it('uses activeFolder (absolute) when no folderPath is supplied and a folder is open', async () => {
    useUIStore.getState().setActiveFolder('/opened/folder')
    const { result } = renderHook(() => useCreateDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ title: 'X' })
    })
    expect((api.documents.create.mock.calls[0][0] as { folderPath?: string }).folderPath).toBe(
      '/opened/folder',
    )
  })

  it('prefers an explicit folderPath over activeFolder', async () => {
    useUIStore.getState().setActiveFolder('/opened/folder')
    const { result } = renderHook(() => useCreateDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ title: 'X', folderPath: '/explicit/path' })
    })
    expect((api.documents.create.mock.calls[0][0] as { folderPath?: string }).folderPath).toBe(
      '/explicit/path',
    )
  })

  it('honors an explicit memoryOnly: false (not coerced to true)', async () => {
    const { result } = renderHook(() => useCreateDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ title: 'X', memoryOnly: false })
    })
    expect((api.documents.create.mock.calls[0][0] as { memoryOnly?: boolean }).memoryOnly).toBe(
      false,
    )
  })
})

describe('useUpdateDocument', () => {
  it('updates and refreshes the detail + list caches on success', async () => {
    const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    const { result } = renderHook(() => useUpdateDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ id: '1', updates: { content: 'x' } })
    })
    expect(api.documents.update).toHaveBeenCalledWith('1', { content: 'x' })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('does not crash when the update returns no document', async () => {
    api.documents.update.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useUpdateDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ id: '1', updates: { content: 'x' } })
    })
    expect(api.documents.update).toHaveBeenCalled()
  })
})

describe('useDeleteDocument', () => {
  it('deletes and invalidates the document list on success', async () => {
    const { result } = renderHook(() => useDeleteDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync('1')
    })
    expect(api.documents.delete).toHaveBeenCalledWith('1')
  })
})

describe('useSaveDocumentAs', () => {
  it('saves to a new path and refreshes caches on success', async () => {
    const { result } = renderHook(() => useSaveDocumentAs(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ id: '1', filePath: '/new.md', updates: { content: 'x' } })
    })
    expect(api.documents.saveAs).toHaveBeenCalledWith('1', '/new.md', { content: 'x' })
  })

  it('does not crash when the save returns no document', async () => {
    api.documents.saveAs.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useSaveDocumentAs(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ id: '1', filePath: '/new.md', updates: { content: 'x' } })
    })
    expect(api.documents.saveAs).toHaveBeenCalled()
  })
})

describe('useReloadDocument', () => {
  it('reloads from disk and refreshes caches on success', async () => {
    const { result } = renderHook(() => useReloadDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync('1')
    })
    expect(api.documents.reload).toHaveBeenCalledWith('1')
  })

  it('does not crash when the reload returns no document', async () => {
    api.documents.reload.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useReloadDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync('1')
    })
    expect(api.documents.reload).toHaveBeenCalled()
  })
})

describe('useSetEncoding', () => {
  it('re-decodes with a chosen encoding and refreshes caches on success', async () => {
    const { result } = renderHook(() => useSetEncoding(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ id: '1', encoding: 'gbk' })
    })
    expect(api.documents.setEncoding).toHaveBeenCalledWith('1', 'gbk')
  })

  it('does not crash when setEncoding returns no document', async () => {
    api.documents.setEncoding.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useSetEncoding(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync({ id: '1', encoding: 'gbk' })
    })
    expect(api.documents.setEncoding).toHaveBeenCalled()
  })
})

describe('useFileStat', () => {
  it('does not query when filePath is empty (enabled false)', async () => {
    const { result } = renderHook(() => useFileStat(''), { wrapper: wrapper() })
    expect(result.current.fetchStatus).toBe('idle')
    expect(api.documents.stat).not.toHaveBeenCalled()
  })

  it('does not query when filePath is null/undefined (enabled false)', async () => {
    const { result } = renderHook(() => useFileStat(null), { wrapper: wrapper() })
    expect(result.current.fetchStatus).toBe('idle')
    expect(api.documents.stat).not.toHaveBeenCalled()
  })

  it('queries stat when filePath is provided', async () => {
    renderHook(() => useFileStat('/docs/a.md'), { wrapper: wrapper() })
    await waitFor(() => expect(api.documents.stat).toHaveBeenCalledWith('/docs/a.md'))
  })
})

describe('useImportDocument', () => {
  it('imports a single file and refreshes caches on success', async () => {
    const { result } = renderHook(() => useImportDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync('/docs/a.md')
    })
    expect(api.documents.import).toHaveBeenCalledWith('/docs/a.md')
  })

  it('does not crash when the import returns no document', async () => {
    api.documents.import.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useImportDocument(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync('/docs/a.md')
    })
    expect(api.documents.import).toHaveBeenCalled()
  })
})

describe('useImportDocuments', () => {
  it('batch-imports and invalidates the list when results are returned', async () => {
    const { result } = renderHook(() => useImportDocuments(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync(['/a.md', '/b.md'])
    })
    expect(api.documents.importMany).toHaveBeenCalledWith(['/a.md', '/b.md'])
  })

  it('does nothing when the batch import returns zero documents', async () => {
    api.documents.importMany.mockImplementationOnce(async () => [])
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    const { result } = renderHook(() => useImportDocuments(), { wrapper: wrapper() })
    result.current.mutate(['/a.md'])
    await waitFor(() => expect(api.documents.importMany).toHaveBeenCalled())
    // No list invalidation because the result array was empty.
    expect(invalidateSpy).not.toHaveBeenCalled()
    invalidateSpy.mockRestore()
  })
})

describe('useOpenPaths', () => {
  it('returns null when no paths are given', async () => {
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    let out: { folder: string; documentId?: string } | null = null
    await act(async () => {
      out = await result.current.mutateAsync([])
    })
    expect(out).toBeNull()
  })

  it('returns null when no markdown files are found', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({ directories: ['/d'], markdownFiles: [] })
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    let out: { folder: string; documentId?: string } | null = null
    await act(async () => {
      out = await result.current.mutateAsync(['/d'])
    })
    expect(out).toBeNull()
  })

  it('returns null when the batch import yields zero documents', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/d'],
      markdownFiles: ['/d/a.md'],
    })
    api.documents.importMany.mockResolvedValueOnce([])
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    let out: { folder: string; documentId?: string } | null = null
    await act(async () => {
      out = await result.current.mutateAsync(['/d'])
    })
    expect(out).toBeNull()
  })

  // Opening a workspace is a switch: unsaved edits live only in the editor buffer, so ask first
  // (ADR-0023 — never discard silently).
  it('asks before discarding unsaved edits, then opens when confirmed', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/opened'],
      markdownFiles: ['/opened/a.md'],
    })
    useUIStore.getState().setDirty(true)
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync(['/opened'])
    })
    expect(api.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('/opened')
    useUIStore.getState().setDirty(false)
  })

  it('aborts the open when the user keeps their edits (nothing is imported)', async () => {
    api.dialog.confirm.mockResolvedValueOnce(false)
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/opened'],
      markdownFiles: ['/opened/a.md'],
    })
    useUIStore.getState().setDirty(true)
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    let out: unknown = 'unset'
    await act(async () => {
      out = await result.current.mutateAsync(['/opened'])
    })
    expect(api.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(out).toBeNull()
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
    expect(api.documents.importMany).not.toHaveBeenCalled()
    useUIStore.getState().setDirty(false)
  })

  it('imports the files, sets the active folder to the opened directory and activates the first doc', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/opened'],
      markdownFiles: ['/opened/a.md', '/opened/b.md'],
    })
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    let out: { folder: string; documentId: string } | null = null
    await act(async () => {
      out = await result.current.mutateAsync(['/opened'])
    })
    expect(out).toEqual({ folder: '/opened', documentId: '/opened/a.md', note: 'directory' })
    expect(useUIStore.getState().activeFolder).toBe('/opened')
    expect(useUIStore.getState().activeDocumentId).toBe('/opened/a.md')
    // The root is handed to the main process so it can be watched recursively — BEFORE the
    // import, because setting it clears the store (ADR-0023).
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('/opened')
    const rootOrder = api.documents.setWorkspaceRoot.mock.invocationCallOrder[0]
    const importOrder = api.documents.importMany.mock.invocationCallOrder[0]
    expect(rootOrder).toBeLessThan(importOrder)
  })

  it('uses the parent dir as the root when only a file is opened', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: [],
      markdownFiles: ['/only/file.md'],
    })
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync(['/only/file.md'])
    })
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('/only')
  })

  // Several directories now converge on their common ancestor instead of silently adopting the
  // first one (D15 — the old `directories[0]` bug, F21).
  it('converges several directories on their common ancestor', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/ws/a', '/ws/b'],
      markdownFiles: ['/ws/a/1.md', '/ws/b/2.md'],
    })
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync(['/ws/a', '/ws/b'])
    })
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('/ws')
  })

  // Adopting the ancestor REPLACES the workspace (the old store is cleared), so the user must
  // be told what the new root is — the refusal sibling of this case lists its candidates.
  it('names the new root when several directories converge on their ancestor (D15)', async () => {
    useUIStore.getState().setDirty(false)
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/ws/a', '/ws/b'],
      markdownFiles: ['/ws/a/1.md', '/ws/b/2.md'],
    })
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync(['/ws/a', '/ws/b'])
    })
    expect(api.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(api.dialog.confirm.mock.calls[0][0].message).toContain('/ws')
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('/ws')
  })

  // Unrelated roots cannot be one workspace: refuse and leave the current one untouched, rather
  // than picking one and watching only it.
  it('refuses unrelated directories instead of silently picking one', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/one', '/two'],
      markdownFiles: ['/one/a.md', '/two/b.md'],
    })
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    let out: unknown = undefined
    await act(async () => {
      out = await result.current.mutateAsync(['/one', '/two'])
    })
    expect(out).toBeNull()
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
    expect(api.documents.importMany).not.toHaveBeenCalled()
  })

  it('never imports a file that would sit outside the root (D20)', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/ws'],
      markdownFiles: ['/ws/in.md', '/elsewhere/out.md'],
    })
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    await act(async () => {
      await result.current.mutateAsync(['/ws'])
    })
    expect(api.documents.importMany).toHaveBeenCalledWith(['/ws/in.md'])
  })

  // Unlike the old additive `setOpenFolder`, setting the root is NOT best-effort: it defines the
  // scope the whole Search view and replace pipeline reason about, so proceeding with an unknown
  // root would be worse than failing.
  it('propagates a failure to set the root instead of opening half a workspace', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/opened'],
      markdownFiles: ['/opened/a.md'],
    })
    api.documents.setWorkspaceRoot.mockRejectedValueOnce(new Error('ipc down'))
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    await expect(result.current.mutateAsync(['/opened'])).rejects.toThrow('ipc down')
    expect(api.documents.importMany).not.toHaveBeenCalled()
  })

  it('falls back to the file parent dir when no directory is resolved', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: [],
      markdownFiles: ['/only/file.md'],
    })
    const { result } = renderHook(() => useOpenPaths(), { wrapper: wrapper() })
    let out: { folder: string; documentId?: string } | null = null
    await act(async () => {
      out = (await result.current.mutateAsync(['/only/file.md'])) as {
        folder: string
        documentId?: string
      } | null
    })
    expect((out as unknown as { folder: string } | null)?.folder).toBe('/only')
  })
})

describe('useOpenFolder', () => {
  it('opens a folder by delegating to useOpenPaths', async () => {
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['/folder'],
      markdownFiles: ['/folder/x.md'],
    })
    const { result } = renderHook(() => useOpenFolder(), { wrapper: wrapper() })
    let out: { folder: string; documentId?: string } | null = null
    await act(async () => {
      out = (await result.current.mutateAsync('/folder')) as {
        folder: string
        documentId?: string
      } | null
    })
    expect(api.files.resolvePaths).toHaveBeenCalledWith(['/folder'])
    expect(out).not.toBeNull()
  })
})

// §5.6.1: create/delete change the document SET, which is part of what the main process
// validates a replace plan against — so the success callbacks must bump the revision, or an
// in-flight plan could be applied against a stale set.
describe('useDocuments — documentStateRevision bumps', () => {
  it('bumps when a document is created and again when one is deleted', async () => {
    const before = useUIStore.getState().documentStateRevision

    const create = renderHook(() => useCreateDocument(), { wrapper: wrapper() })
    await act(async () => {
      await create.result.current.mutateAsync({ title: 'X' })
    })
    const afterCreate = useUIStore.getState().documentStateRevision
    expect(afterCreate).toBeGreaterThan(before)

    const del = renderHook(() => useDeleteDocument(), { wrapper: wrapper() })
    await act(async () => {
      await del.result.current.mutateAsync('1')
    })
    expect(useUIStore.getState().documentStateRevision).toBeGreaterThan(afterCreate)
  })
})
