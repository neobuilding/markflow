import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Document } from '../types'
import { normalizePathSegments } from '../lib/utils'
import { resolveWorkspaceRoot } from '../lib/workspace-root'
import { isDirInFolder } from '../../../../shared/fileUtils'
import { t } from '../i18n/translate'
import { useUIStore } from '../store/ui'
import { DOCS_KEY, queryClient } from '../lib/queryClient'
import { isMemoryOnly } from '../lib/sidebarDrafts'

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
/**
 * Whether an unsaved (memory-only) draft already exists — the single read of the "at most one
 * draft" rule for the UI.
 *
 * Every New Draft entry point disables itself in this state: the global toolbar button, the
 * editor's empty-state menu item, and (through the `menu:set-has-draft` sync in `App`) the native
 * File > New Draft item. `createDraft` re-checks the same question as the backstop for the paths a
 * disabled control cannot block (the window keydown handler, the menu accelerator).
 *
 * It reads the very list query the sidebar uses, so it costs no extra fetch. That query is
 * folder-scoped, but `documents:list` always includes memory-only drafts whatever folder is open,
 * so the answer stays correct with a folder open.
 */
export function useHasMemoryOnlyDraft(): boolean {
  const activeFolder = useUIStore((s) => s.activeFolder)
  const { data } = useDocuments(activeFolder ?? undefined)
  return (data ?? []).some(isMemoryOnly)
}

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
      // A new document changes the document SET, which is part of what the main process validates
      // against (`documentStateRevision`, ADR-0023 §5.6.1). Bumping here is what invalidates an
      // in-flight replace plan instead of letting it be applied against a stale document set.
      useUIStore.getState().bumpDocumentState()
    },
  })
}

/**
 * The single "New Draft" action. Every entry point (global toolbar button, Ctrl/Cmd+N, the native
 * File menu, the editor empty-state context menu and the sidebar's draft entries) goes through
 * here, so they cannot disagree about the unsaved-changes guard or the resulting document state.
 *
 * A draft is memory-only: nothing touches the filesystem until the first Save (Save As). This is
 * deliberately NOT a hook — the keyboard and menu handlers live outside React render, so they can
 * call it directly. It repeats the two cache side effects of `useCreateDocument.onSuccess` for the
 * same reason (a direct IPC call does not go through the mutation).
 *
 * Two invariants keep drafts well-behaved:
 *  - `inFlight` collapses the two Ctrl/Cmd+N paths (the window keydown handler and the native menu
 *    accelerator) when both fire for one physical key press, so a single press can't create two
 *    drafts at once.
 *  - `hasMemoryOnlyDraft()` enforces "at most one unsaved draft": once a memory-only document
 *    exists, a second New Draft is refused. The visible New Draft controls disable themselves in
 *    that state — the global toolbar button and the editor empty-state item read
 *    `useHasMemoryOnlyDraft()`, the native File menu mirrors it over `menu:set-has-draft`, and the
 *    sidebar's own entries only render while no draft exists. This guard is the backstop for the
 *    keyboard path, which bypasses every disabled control.
 */
let inFlight: Promise<void> | null = null

// True when an unsaved (memory-only) draft already exists.
//
// The question is asked of the main-process store, not of the React Query cache: the cache is
// keyed per folder (`['documents', 'list', folderPath]`), so with a folder open the entry holding
// the draft lives under the folder's key — a folder-less cache read would miss it and let a second
// draft through. `documents:list` always includes memory-only drafts regardless of the folder
// filter, so one folder-scoped call answers it authoritatively.
async function hasMemoryOnlyDraft(): Promise<boolean> {
  const activeFolder = useUIStore.getState().activeFolder
  const docs = await window.api.documents.list(activeFolder ?? undefined)
  return docs.some(isMemoryOnly)
}

export function createDraft(): Promise<void> {
  // R5 plan A print-mode lock: creating a draft would switch the active document while a print
  // job is in flight. Guard at the shared entry point so every caller (Ctrl+N, native menu,
  // sidebar, global toolbar) is covered without duplicating the rule.
  if (useUIStore.getState().printing) return Promise.resolve()
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      if (await hasMemoryOnlyDraft()) return
      if (!(await useUIStore.getState().guardUnsavedSwitch())) return
      const doc = await window.api.documents.create({ title: 'Untitled', memoryOnly: true })
      const ui = useUIStore.getState()
      // Same transaction as `selectDocument`: once the guard has thrown the outgoing document's
      // edits away, its unsaved buffer has to go too — otherwise search & replace keeps matching
      // text the user explicitly discarded.
      if (ui.dirty) ui.clearUnsavedBuffer(ui.activeDocumentId ?? '')
      ui.setActiveDocumentId(doc.id)
      ui.setEditable(true)
      ui.setIsNewUnsaved(true)
      await queryClient.invalidateQueries({ queryKey: DOCS_KEY })
      ui.bumpDocumentState()
    } catch (e) {
      // A rejected IPC (e.g. the renderer/main bridge is down) must not become an unhandled
      // rejection on the `void createDraft()` call sites — log it instead of surprising the user
      // with a frozen New Draft click. (No app-wide error channel exists yet; surfacing this to
      // the user is a follow-up.)
      console.error('New Draft failed', e)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
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
      // Same reasoning as create: the document set changed, so any replace plan computed against
      // the old one must not remain applicable (ADR-0023 §5.6.1).
      useUIStore.getState().bumpDocumentState()
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

// Open a set of file/folder paths. Opening REPLACES the workspace (ADR-0023): the main process
// clears the document store and rebuilds the watcher over the new root, so exactly one root is
// ever open — the store used to accumulate folders (F20) and the watcher used to keep only the
// first one (F21).
//
// 1) the main process expands folders into a Markdown file list
// 2) converge the opened directories into ONE root (refusing unrelated ones, D15)
// 3) set that root (which clears the old workspace), then import the files under it
// 4) activate the first document, leaving edit mode alone (see the note below)
export function useOpenPaths() {
  const importMut = useImportDocuments()
  return useMutation({
    mutationFn: async (paths: string[]) => {
      if (!paths || paths.length === 0) return null
      const { directories, markdownFiles } = await window.api.files.resolvePaths(paths)
      if (markdownFiles.length === 0) return null

      const resolution = resolveWorkspaceRoot(directories, markdownFiles[0])
      if (!resolution.ok) {
        // Refuse rather than silently adopting one of them: the user gets the list so they can
        // open them one at a time. Nothing is imported and the current workspace is untouched.
        // `markdownFiles` is non-empty here, so the only failure reason is `multiple-roots`.
        /* v8 ignore next */
        if (resolution.reason === 'multiple-roots') {
          await window.api.dialog.confirm({
            message: t('app.multipleRootsRefused'),
            detail: resolution.candidates.join('\n'),
            okText: t('app.ok'),
          })
        }
        return null
      }
      const root = resolution.root

      // Several dropped directories converged on one ancestor: adopting it REPLACES the workspace
      // (the old store is cleared), so name the new root instead of switching silently (D15 — the
      // refusal sibling of this case already lists its candidates).
      if (resolution.note === 'common-ancestor') {
        await window.api.dialog.confirm({
          message: t('app.commonAncestorRoot', { root }),
          okText: t('app.ok'),
        })
      }

      // Opening is a workspace switch: unsaved edits live only in the editor buffer and would be
      // lost, so ask first (ADR-0023 — never discard silently).
      const ui0 = useUIStore.getState()
      if (ui0.dirty) {
        const discard = await window.api.dialog.confirm({
          message: t('app.unsavedOpenWorkspace', { title: ui0.activeDocumentTitle ?? '' }),
          okText: t('app.confirmDiscard'),
          cancelText: t('app.confirmKeep'),
        })
        if (!discard) return null
      }

      // Order matters: setting the root clears the store, so the import must come after it. The
      // watcher starts with ignoreInitial, so already-imported files are not re-reported.
      await window.api.documents.setWorkspaceRoot(root)
      // D20: a document outside the root has no relative path, which would make scope matching and
      // the replace pipeline meaningless for it.
      const files = markdownFiles.filter((f) => isDirInFolder(f, root))
      const imported = await importMut.mutateAsync(files)
      if (imported.length === 0) return null

      const ui = useUIStore.getState()
      ui.setActiveFolder(root)
      ui.setActiveDocumentId(imported[0].id)
      // NOTE: do NOT force `editable` to false here. `editable` is a workspace-wide mode that
      // defaults to false only when there is no document open (store default + closeWorkspace/
      // closeDocument reset it). Forcing it false on every open would clobber the user's current
      // edit mode e.g. after switching to edit, opening/switching another file would silently
      // revert to read-only and the editor could not be edited ("switch file -> can't edit" bug).
      ui.setDirty(false) // opening/importing a file clears any stale dirty flag
      ui.bumpDocumentState()
      return { folder: root, documentId: imported[0].id, note: resolution.note }
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
