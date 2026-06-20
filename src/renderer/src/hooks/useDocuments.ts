import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Document } from '../types'

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

export function useStarredDocuments() {
  return useQuery({
    queryKey: [...DOCS_KEY, 'starred'],
    queryFn: () => window.api.documents.starred(),
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

export function useToggleStar() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.documents.toggleStar(id),
    onSuccess: (data: Document) => {
      qc.setQueryData([...DOCS_KEY, 'detail', data.id], data)
      qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'list'] })
      qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'starred'] })
    }
  })
}

// 导入单个 Markdown 文件
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

// 批量导入多个 Markdown 文件
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
