import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Document } from '../types'
import { dirName } from '../lib/utils'
import { useUIStore } from '../store/ui'

const DOCS_KEY = ['documents']

export function useDocuments(folderPath?: string) {
  return useQuery({
    queryKey: [...DOCS_KEY, 'list', folderPath ?? ''],
    queryFn: () => window.api.documents.list(folderPath),
    staleTime: 0
  })
}

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: [...DOCS_KEY, 'detail', id],
    queryFn: () => window.api.documents.get(id!),
    enabled: id !== null,
    staleTime: 0
  })
}

export function useCreateDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: { title?: string; folderPath?: string; content?: string }) =>
      window.api.documents.create(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCS_KEY })
    }
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
    }
  })
}

export function useDeleteDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.documents.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCS_KEY })
    }
  })
}

// Save As: write the content to a new file path and point the current document record at that file
export function useSaveDocumentAs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      filePath,
      updates
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
    }
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
    }
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
    }
  })
}

// Query on-disk file details (size / created time / modified time)
export function useFileStat(filePath: string | null | undefined) {
  return useQuery({
    queryKey: ['fileStat', filePath ?? ''],
    queryFn: () => window.api.documents.stat(filePath!),
    enabled: !!filePath,
    staleTime: 5000
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
    }
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
    }
  })
}

// Open a set of file/folder paths:
// 1) the main process expands folders into a Markdown file list
// 2) batch-import them into the database
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
      const ui = useUIStore.getState()
      ui.setActiveFolder(folder)
      ui.setActiveDocumentId(imported[0].id)
      ui.setEditable(false) // files open read-only by default
      return { folder, documentId: imported[0].id }
    }
  })
}

// Open a single folder (batch-import all Markdown files inside it)
export function useOpenFolder() {
  const openPaths = useOpenPaths()
  return useMutation({
    mutationFn: async (folderPath: string) => openPaths.mutateAsync([folderPath])
  })
}
