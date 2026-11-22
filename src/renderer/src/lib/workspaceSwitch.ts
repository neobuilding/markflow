import { queryClient, DOCS_KEY } from './queryClient'
import { arePathsSame, isDirInFolder, isInFolder } from '../../../../shared/fileUtils'
import { pathCaseSensitive } from './utils'
import { isMemoryOnly } from './sidebarDrafts'
import { useUIStore, selectFileLocked } from '../store/ui'
import { useNavigationHistory, withoutHistoryRecording } from '../store/navigationHistory'
import type { OpenMode } from '../store/navigationHistory'

export interface SwitchWorkspaceOptions {
  /** How the resulting navigation was opened; replayed verbatim by Back/Forward. */
  openMode?: OpenMode
  /**
   * Open this file as the active document right after the swap. It is the "switch workspace"
   * exit of the four-way external-file dialog: the user picked a file OUTSIDE the current
   * workspace and asked for it to be opened HERE with the workspace moved to its folder.
   * Without it the swap keeps (or closes) the CURRENT document, as a folder switch does.
   */
  openPath?: string
  /** Title stored in the history entry (shown in the history menu). */
  title?: string
  /**
   * Record the resulting navigation in the history. False while REPLAYING an existing entry
   * (Back/Forward move the cursor, they never append).
   */
  record?: boolean
}

/**
 * Switch the entire workspace to `nextRoot` (double-click a subfolder, ↑, breadcrumb, or the
 * "switch workspace" choice of the external-link dialog). One service owns the whole transaction:
 * print/export lock, the conditional unsaved guard, the main store/watcher swap, keeping or closing
 * the active document, and a single history entry.
 *
 * Keep semantics: when the current document is still inside `nextRoot`, it is re-imported (the store
 * is cleared by the swap, so the old id is gone) and its unsaved buffer is migrated to the new id —
 * the user sees the same file still open with its edits intact. Otherwise the document is closed
 * and NO default document is opened.
 */
export async function switchWorkspace(
  nextRoot: string,
  options: SwitchWorkspaceOptions = {},
): Promise<boolean> {
  const ui = useUIStore.getState()
  if (selectFileLocked(ui)) return false

  const activeId = ui.activeDocumentId
  const current = activeId ? await window.api.documents.get(activeId) : null
  const currentPath = current?.filePath && !isMemoryOnly(current) ? current.filePath : null
  const willKeep = !!currentPath && isInFolder(currentPath, nextRoot)

  // An explicit target REPLACES the current document: the user asked for THIS file in the new
  // workspace, so the current one is closed even when it happens to live inside the new root.
  const targetPath = options.openPath ?? null
  const keepCurrent = !targetPath && willKeep

  // The single close point owns the unsaved guard (ADR-0039 §3.2, ADR-0038 §3.2 decision 6):
  // it names the document being left and restores editor focus on "Keep editing" (ADR-0023
  // decision 9). The keep branch loses nothing — its buffer is migrated below — so it never
  // prompts, and there is no second "open the new workspace?" prompt after the file guard.
  if (!keepCurrent && !(await useUIStore.getState().guardUnsavedSwitch())) return false

  // Capture the buffer BEFORE the swap clears the store's view of the current document.
  // Re-read the store here instead of using the `ui` snapshot from line 43: both the document
  // lookup and the unsaved guard are awaits, and every keystroke replaces `unsavedBuffers`
  // wholesale (ui.ts reportUnsavedBuffer). A stale snapshot would silently drop edits made
  // while those awaits were in flight when the buffer is migrated to the re-imported id.
  const buffer =
    keepCurrent && currentPath && activeId
      ? useUIStore.getState().unsavedBuffers[activeId]
      : undefined
  // Closing the document MUST precede closing the workspace (ADR-0038 §3.2 decision 6): it
  // deletes a memory-only draft and clears dirty/buffers before the store swap. In the keep
  // branch the document survives — it is re-imported below — so nothing is closed here.
  if (!keepCurrent) useUIStore.getState().closeDocument()
  const pathToKeep = keepCurrent ? currentPath : null

  const opened = await withoutHistoryRecording(async () => {
    await window.api.documents.setWorkspaceRoot(nextRoot)
    useUIStore.getState().setWorkspaceRoot(nextRoot)

    // The swap cleared the store and the watcher starts with ignoreInitial, so files already on
    // disk are never reported as additions. Back-fill them here: without a batch import the new
    // root stays empty, so `documents:list` has no files and the sidebar hides every folder too
    // (document-less branches are filtered out by default, ADR-0010). The target/kept file is
    // imported separately below to migrate its id and unsaved buffer; importing it in both places
    // would create two rows for one path (getDocumentByFilePath compares paths literally).
    // resolvePaths returns node:path.join() results (backslashes on Windows) while a link or
    // stored path may use forward slashes — fold separators before comparing so the same file is
    // recognised as the one we are about to import below.
    const { markdownFiles } = await window.api.files.resolvePaths([nextRoot])
    const caseSensitive = pathCaseSensitive()
    const forwardSlashes = (path: string) => path.replace(/\\/g, '/')
    const backfill = markdownFiles.filter((file) => {
      if (!isDirInFolder(file, nextRoot)) return false
      const normalized = forwardSlashes(file)
      if (targetPath && arePathsSame(normalized, forwardSlashes(targetPath), caseSensitive)) {
        return false
      }
      if (pathToKeep && arePathsSame(normalized, forwardSlashes(pathToKeep), caseSensitive)) {
        return false
      }
      return true
    })
    await window.api.documents.importMany(backfill)

    // The requested target first: it is the whole point of the "switch workspace" exit.
    if (targetPath) {
      const doc = await window.api.documents.import(targetPath)
      if (doc) {
        useUIStore.getState().setActiveDocumentId(doc.id)
        return { path: targetPath, title: doc.title }
      }
    }

    if (pathToKeep) {
      const doc = await window.api.documents.import(pathToKeep)
      if (doc) {
        useUIStore.getState().setActiveDocumentId(doc.id)
        if (buffer) {
          useUIStore.getState().reportUnsavedBuffer(doc.id, buffer.content)
          useUIStore.getState().setDirty(true)
        }
        return { path: pathToKeep, title: doc.title }
      }
      // The swap wiped the old store entry. If re-import fails there is no document left to
      // keep, so the stale id and its buffer must be closed here (the non-keep branch already
      // closed before the swap).
      useUIStore.getState().closeDocument()
    }

    // Outside the new root (or import failed): the current document was already closed above,
    // so there is no default document to open and no dirty flag left to clear.
    return null
  })

  useUIStore.getState().bumpDocumentState()
  queryClient.invalidateQueries({ queryKey: DOCS_KEY })

  if (opened && options.record !== false) {
    useNavigationHistory
      .getState()
      .push(opened.path, { openMode: options.openMode ?? 'in-place', title: opened.title })
  }
  return true
}
