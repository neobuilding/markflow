import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Document } from '../types'
import { dirName, normalizePathSegments } from '../lib/utils'
import { useUIStore } from '../store/ui'
import { DOCS_KEY } from '../lib/queryClient'

export function useDocuments(folderPath?: string) {
  return useQuery({
    queryKey: [...DOCS_KEY, 'list', folderPath ?? ''],
    queryFn: () => window.api.documents.list(folderPath),
    staleTime: 0,
  })
}

// Directories below `folderPath` (recursive, empty ones included). The sidebar tree is
// otherwise derived from documents alone, which has no node to represent a folder that
// holds no Markdown file and a folder the user just created is always empty
export function useFolderDirs(folderPath?: string | null) {
  return useQuery({
    queryKey: [...DOCS_KEY, 'dirs', folderPath ?? ''],
    // folderPath is only read here while enabled (see `enabled` below), so the `?? ''`
    // branch is unreachable in practice; keep it for type-safety without a coverage gap.
    /* v8 ignore next */
    queryFn: () => window.api.documents.listFolders(folderPath ?? ''),
    enabled: !!folderPath,
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
      // the active list VS Code "save into the opened folder" semantics (#13)
      const activeFolder = useUIStore.getState().activeFolder
      const folderPath = params.folderPath ?? (activeFolder ? activeFolder : undefined)
      return window.api.documents.create({
        ...params,
        folderPath,
        // New documents are memory-only drafts by default: no file is written to disk
        // until the user explicitly saves (Save As). See
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
      // Awaited so the watcher is live before the folder becomes active otherwise a
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
      // edit mode e.g. after switching to edit, opening/switching another file would silently
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

// Switch line endings of a file on disk (, destructive write). The renderer
// must confirm first and reload afterwards; invalidation refreshes the EOL pill.
export function useSetEol() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ filePath, eol }: { filePath: string; eol: '\r\n' | '\n' }) =>
      window.api.documents.setEol(filePath, eol),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: [...DOCS_KEY, 'eol', vars.filePath] })
    },
  })
}

// Re-detect a file's encoding from disk . Returns the detected encoding
// so the caller can offer to apply it via useSetEncoding.
export function useDetectEncoding() {
  return useMutation({
    mutationFn: (filePath: string) => window.api.documents.detectEncoding(filePath),
  })
}

// Create a folder on disk
export function useCreateFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (folderPath: string) => window.api.documents.createFolder(folderPath),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCS_KEY })
    },
  })
}

// Re-point every cached path that lives under `oldPath` onto `newPath`, so the sidebar
// never holds a stale document/folder pointing at the old name while the refetch is in
// flight. The list query (store scan + IPC) resolves after the dirs query (a local disk
// walk); without this rewrite the tree would show the new folder (fresh dirs) next to the
// old one (stale list doc) for a frame, then snap to just the new folder.
//
// Matching covers both the exact path (the renamed folder itself, and a document whose
// folderPath equals it — neither carries a trailing separator) and anything beneath it.
function rewriteFolderInCache(
  qc: ReturnType<typeof useQueryClient>,
  oldPath: string,
  newPath: string,
): void {
  const oldNorm = normalizePathSegments(oldPath).replace(/\/$/, '').toLowerCase()
  const newNorm = normalizePathSegments(newPath).replace(/\/$/, '')
  const prefix = oldNorm + '/'
  const hits = (p: string) => {
    const n = normalizePathSegments(p).toLowerCase()
    return n === oldNorm || n.startsWith(prefix)
  }
  // List caches: arrays of Document.
  qc.setQueriesData({ queryKey: [...DOCS_KEY, 'list'] }, (docs: unknown) => {
    if (!Array.isArray(docs)) return docs
    return (docs as Array<{ filePath: string; folderPath: string }>).map((d) => {
      const fpHit = hits(d.filePath)
      const foHit = hits(d.folderPath)
      if (!fpHit && !foHit) return d
      return {
        ...d,
        filePath: fpHit
          ? newNorm + normalizePathSegments(d.filePath).slice(oldNorm.length)
          : d.filePath,
        folderPath: foHit
          ? newNorm + normalizePathSegments(d.folderPath).slice(oldNorm.length)
          : d.folderPath,
      }
    })
  })
  // Dirs caches: arrays of folder-path strings.
  qc.setQueriesData({ queryKey: [...DOCS_KEY, 'dirs'] }, (dirs: unknown) => {
    if (!Array.isArray(dirs)) return dirs
    return (dirs as string[]).map((dir) => {
      if (!hits(dir)) return dir
      return newNorm + normalizePathSegments(dir).slice(oldNorm.length)
    })
  })
}

// Rename a folder on disk
export function useRenameFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ oldPath, newPath }: { oldPath: string; newPath: string }) =>
      window.api.documents.renameFolder(oldPath, newPath),
    onSuccess: (_data, { oldPath, newPath }) => {
      // Fix the cache synchronously so the sidebar never flashes the old folder; the
      // invalidate below then refreshes both queries from the (already re-pointed) store.
      rewriteFolderInCache(qc, oldPath, newPath)
      qc.invalidateQueries({ queryKey: DOCS_KEY })
    },
  })
}

// Rename a single file on disk (decoupled from edit mode: a file rename is a direct move,
// not a content edit, so it works for any file — not just the one open in the editor — and
// persists immediately without a save).
export function useRenameFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ oldPath, newPath }: { oldPath: string; newPath: string }) =>
      window.api.documents.renameFile(oldPath, newPath),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCS_KEY })
    },
  })
}

// Undo the most recent file/folder rename. The main process owns the (single-slot) history,
// so this only triggers it and refreshes when something actually moved.
// Deliberately NOT bound to a global Ctrl+Z: the caller decides by focus, so the editor
// keeps Ctrl+Z for text undo.
export function useUndoRename() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.documents.undoRename(),
    onSuccess: (res) => {
      if (res?.ok) qc.invalidateQueries({ queryKey: DOCS_KEY })
    },
  })
}

// Delete a folder on disk
export function useDeleteFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (folderPath: string) => window.api.documents.deleteFolder(folderPath),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCS_KEY })
    },
  })
}
