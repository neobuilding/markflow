import { queryClient, DOCS_KEY } from './queryClient'
import { isInFolder } from '../../../../shared/fileUtils'
import { isMemoryOnly } from './sidebarDrafts'
import { useUIStore, selectFileLocked } from '../store/ui'
import { useNavigationHistory, withoutHistoryRecording } from '../store/navigationHistory'
import { t } from '../i18n/translate'
import type { OpenMode } from '../store/navigationHistory'

export interface SwitchWorkspaceOptions {
  openMode?: OpenMode
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

  // Only ask about unsaved edits when the document is actually going away. In the keep branch the
  // buffer is migrated to the re-imported id, so nothing is lost and no prompt is warranted.
  if (!willKeep && ui.dirty) {
    const discard = await window.api.dialog.confirm({
      message: t('app.unsavedOpenWorkspace', { title: ui.activeDocumentTitle ?? '' }),
      okText: t('app.confirmDiscard'),
      cancelText: t('app.confirmKeep'),
    })
    if (!discard) return false
  }

  // Capture the buffer BEFORE the swap clears the store's view of the current document.
  const buffer = currentPath && activeId ? ui.unsavedBuffers[activeId] : undefined
  const pathToKeep = currentPath

  const moved = await withoutHistoryRecording(async () => {
    await window.api.documents.setWorkspaceRoot(nextRoot)
    useUIStore.getState().setWorkspaceRoot(nextRoot)

    if (pathToKeep) {
      const doc = await window.api.documents.import(pathToKeep)
      if (doc) {
        useUIStore.getState().setActiveDocumentId(doc.id)
        if (buffer) {
          useUIStore.getState().reportUnsavedBuffer(doc.id, buffer.content)
          useUIStore.getState().setDirty(true)
        }
        return true
      }
    }
    // Outside the new root (or import failed): close without opening any default document.
    useUIStore.getState().setActiveDocumentId(null)
    return false
  })

  useUIStore.getState().bumpDocumentState()
  queryClient.invalidateQueries({ queryKey: DOCS_KEY })

  if (moved && pathToKeep) {
    useNavigationHistory.getState().push(pathToKeep, {
      openMode: options.openMode ?? 'in-place',
    })
  }
  return true
}
