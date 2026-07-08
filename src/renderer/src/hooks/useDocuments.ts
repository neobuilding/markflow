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

// 另存为：将内容写入新的文件路径，并把当前文档记录指向该文件
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

// 从磁盘重新加载文件内容
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

// 打开一组文件/文件夹路径：
// 1) 由主进程将文件夹展开为 Markdown 文件列表
// 2) 批量导入到数据库
// 3) 将“当前文件夹”设为打开的目录（单个文件则取其所在目录），激活首个文档
// 4) 默认以只读模式打开（editable=false）
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
      ui.setEditable(false) // 打开文件默认只读
      return { folder, documentId: imported[0].id }
    }
  })
}

// 打开单个文件夹（批量导入其内所有 Markdown 文件）
export function useOpenFolder() {
  const openPaths = useOpenPaths()
  return useMutation({
    mutationFn: async (folderPath: string) => openPaths.mutateAsync([folderPath])
  })
}
