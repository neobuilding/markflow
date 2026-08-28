import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Document } from '../types'
import { dirName } from '../lib/utils'
import { useUIStore } from '../store/ui'
import { DOCS_KEY } from '../lib/queryClient'

export function useDocuments(folderPath?: string) {
  return useQuery({
    queryKey: [...DOCS_KEY, 'list', folderPath ?? ''],
    queryFn: () => window.api.documents.list(folderPath),
    staleTime: 0,
  })
}

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: [...DOCS_KEY, 'detail', id],
    queryFn: () => window.api.documents.get(id!),
    enabled: id !== null,
    staleTime: 0,
  })
}

export function useCreateDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: {
      title?: string
      folderPath?: string
      content?: string
      ext?: string
      memoryOnly?: boolean
    }) => {
      // When the caller does not pin a folder, save non-memory-only docs into the
      // currently opened folder (activeFolder, an absolute path) so they appear in
      // the active list — VS Code "save into the opened folder" semantics (PLAN §6.#13).
      const activeFolder = useUIStore.getState().activeFolder
      const folderPath = params.folderPath ?? (activeFolder ? activeFolder : undefined)
      return window.api.documents.create({
        ...params,
        folderPath,
        // New documents are memory-only drafts by default: no file is written to disk
        // until the user explicitly saves (Save As). See PLAN §6.3.
        memoryOnly: params.memoryOnly ?? true,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCS_KEY })
    },
  })
}

export function useUpdateDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: { title?: string; content?: string } }) =>
      window.api.documents.update(id, updates),
    onSuccess: (data: Document | null) => {
      if (data) {
        qc.setQueryData([...DOCS_KEY, 'detail', data.id], data)
        qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'list'] })
      }
    },
  })
}

export function useDeleteDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.documents.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCS_KEY })
    },
  })
}

// Save As: write the content to a new file path and point the current document record at that file
export function useSaveDocumentAs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      filePath,
      updates,
    }: {
      id: string
      filePath: string
      updates: { title?: string; content?: string }
    }) => window.api.documents.saveAs(id, filePath, updates),
    onSuccess: (data: Document | null) => {
      if (data) {
        qc.setQueryData([...DOCS_KEY, 'detail', data.id], data)
        qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'list'] })
      }
    },
  })
}

// Reload file content from disk
export function useReloadDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.documents.reload(id),
    onSuccess: (data: Document | null) => {
      if (data) {
        qc.setQueryData([...DOCS_KEY, 'detail', data.id], data)
        qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'list'] })
      }
    },
  })
}

// Manually switch encoding: re-decode the on-disk file with the chosen encoding and refresh
// content (no write to disk).
export function useSetEncoding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, encoding }: { id: string; encoding: string }) =>
      window.api.documents.setEncoding(id, encoding),
    onSuccess: (data: Document | null) => {
      if (data) {
        qc.setQueryData([...DOCS_KEY, 'detail', data.id], data)
        qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'list'] })
      }
    },
  })
}

// Query on-disk file details (size / created time / modified time)
export function useFileStat(filePath: string | null | undefined) {
  return useQuery({
    queryKey: ['fileStat', filePath ?? ''],
    queryFn: () => window.api.documents.stat(filePath!),
    enabled: !!filePath,
    staleTime: 5000,
  })
}

// Import a single Markdown file
export function useImportDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (filePath: string) => window.api.documents.import(filePath),
    onSuccess: (data: Document | null) => {
      if (data) {
        qc.setQueryData([...DOCS_KEY, 'detail', data.id], data)
        qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'list'] })
      }
    },
  })
}

// Batch-import multiple Markdown files
export function useImportDocuments() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (filePaths: string[]) => window.api.documents.importMany(filePaths),
    onSuccess: (data: Document[]) => {
      if (data.length > 0) {
        qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'list'] })
      }
    },
  })
}

// Open a set of file/folder paths:
// 1) the main process expands folders into a Markdown file list
// 2) batch-import them into the in-memory document store
// 3) set the "current folder" to the opened directory (or the file's parent for a single file)
//    and activate the first document
// 4) open in read-only mode by default (editable=false)
export function useOpenPaths() {
  const importMut = useImportDocuments()
  return useMutation({
    mutationFn: async (paths: string[]) => {
      if (!paths || paths.length === 0) return null
      const { directories, markdownFiles } = await window.api.files.resolvePaths(paths)
      if (markdownFiles.length === 0) return null
      const imported = await importMut.mutateAsync(markdownFiles)
      if (imported.length === 0) return null
      const folder = directories[0] ?? dirName(markdownFiles[0])
      // Hand the folder to the main process *after* the import above: the watcher
      // starts with ignoreInitial, so files already imported are not re-reported,
      // and it only picks up files created or deleted from here on.
      // Best-effort: the files are already imported, so a watcher that cannot start
      // must not stop us from opening the folder (it only costs live refresh).
      // Awaited so the watcher is live before the folder becomes active — otherwise a
      // file created in between would never be reported.
      try {
        await window.api.documents.setOpenFolder(folder)
      } catch {
        // Watcher unavailable: the folder still opens, just without live refresh.
      }
      const ui = useUIStore.getState()
      ui.setActiveFolder(folder)
      ui.setActiveDocumentId(imported[0].id)
      // NOTE: do NOT force `editable` to false here. `editable` is a workspace-wide mode that
      // defaults to false only when there is no document open (store default + closeWorkspace/
      // closeDocument reset it). Forcing it false on every open would clobber the user's current
      // edit mode — e.g. after switching to edit, opening/switching another file would silently
      // revert to read-only and the editor could not be edited ("switch file -> can't edit" bug).
      ui.setDirty(false) // opening/importing a file clears any stale dirty flag
      return { folder, documentId: imported[0].id }
    },
  })
}

// Open a single folder (batch-import all Markdown files inside it)
export function useOpenFolder() {
  const openPaths = useOpenPaths()
  return useMutation({
    mutationFn: async (folderPath: string) => openPaths.mutateAsync([folderPath]),
  })
}
