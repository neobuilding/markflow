import { queryClient, DOCS_KEY } from './queryClient'
import { sameFilePath } from './previewLinkNavigation'
import { isInFolder } from '../../../../shared/fileUtils'
import { dirName } from './utils'
import { useUIStore, selectFileLocked } from '../store/ui'
import {
  useNavigationHistory,
  withoutHistoryRecording,
  type OpenMode,
  type NavigationEntry,
} from '../store/navigationHistory'
import { switchWorkspace } from './workspaceSwitch'

// One service owns "navigate to a document by path" inside the CURRENT workspace. Workspace
// switching is owned by switchWorkspace (double-click / ↑ / breadcrumb / external-link switch),
// and workspace-external links are dispatched by MarkdownPreview's four-way dialog. This function
// never replaces the workspace root.

export interface NavigateOptions {
  /** Back/Forward already owns the cursor and must not append a new entry. */
  record?: boolean
  openMode?: OpenMode
}

/** Resolve and activate a file by absolute path WITHOUT changing the workspace. */
export async function navigateToPath(
  filePath: string,
  options: NavigateOptions = {},
): Promise<boolean> {
  const ui = useUIStore.getState()
  if (selectFileLocked(ui)) return false
  const stat = await window.api.documents.stat(filePath)
  if (!stat?.exists) return false

  const external = options.openMode === 'external-keep'
  const root = ui.workspaceRoot ?? (await window.api.documents.getWorkspaceRoot())
  // Outside the workspace is allowed ONLY for the "open here, keep workspace" choice, which
  // imports the file as an external document. All other modes must stay inside the root.
  if (root && !isInFolder(filePath, root) && !external) return false

  // File guard first: "Keep editing" cancels the whole navigation before anything is closed.
  // This is the single guard point (Q30): every path that closes the current document guards here,
  // regardless of which UI action triggered it.
  if (!(await ui.guardUnsavedSwitch())) return false
  useUIStore.getState().closeDocument()

  const listed = await window.api.documents.list()
  const doc =
    listed.find((d) => sameFilePath(d.filePath, filePath)) ??
    (await window.api.documents.import(filePath, external ? { external: true } : undefined))
  if (!doc) return false

  const navigate = async () => {
    // Record BEFORE setActiveDocumentId: that setter fires an async recordNavigation() which
    // pushes the same path without metadata. Pushing first makes its de-dup a no-op and preserves
    // this entry's openMode. When recording is suppressed the whole block is wrapped by
    // withoutHistoryRecording, so the setter's push is suppressed too.
    if (options.record !== false) {
      useNavigationHistory.getState().push(filePath, { openMode: options.openMode ?? 'in-place' })
    }
    useUIStore.getState().setActiveDocumentId(doc.id)
    useUIStore.getState().setDirty(false)
    useUIStore.getState().bumpDocumentState()
    queryClient.invalidateQueries({ queryKey: DOCS_KEY })
  }
  if (options.record === false) {
    await withoutHistoryRecording(navigate)
  } else {
    await navigate()
  }
  return true
}

/**
 * Replay a history entry with the semantics it was opened with.
 *
 * An "external-switch" entry was created by moving the workspace to the file's folder, so
 * replaying it must move the workspace back — navigating in place would fail, because the file
 * lies outside the CURRENT root (ADR-0039 §3.4). "external-keep" stays an in-place navigation
 * that imports the file as an external document. Neither replays the four-way dialog.
 */
async function replayEntry(entry: NavigationEntry): Promise<boolean> {
  if (entry.openMode === 'external-switch') {
    return switchWorkspace(dirName(entry.path), {
      openMode: 'external-switch',
      openPath: entry.path,
      title: entry.title,
      record: false,
    })
  }
  return navigateToPath(entry.path, { record: false, openMode: entry.openMode })
}

/** Move Back (-1) or Forward (1), skipping and pruning entries whose files no longer exist. */
export async function moveNavigationHistory(delta: -1 | 1): Promise<boolean> {
  if (selectFileLocked(useUIStore.getState())) return false
  const history = useNavigationHistory.getState()
  for (let guard = 0; guard <= history.entries.length; guard += 1) {
    // Re-read the cursor every iteration: prune() can shift it, and a stale snapshot would keep
    // pruning the wrong (already-gone) index until the loop runs out.
    const current = useNavigationHistory.getState()
    const targetIndex = delta === -1 ? current.cursor - 1 : current.cursor + 1
    const entry = current.entryAt(targetIndex)
    if (!entry) return false
    const stat = await window.api.documents.stat(entry.path)
    if (!stat?.exists) {
      current.prune(entry.path)
      continue
    }
    // Replay with the entry's recorded openMode, WITHOUT appending a new entry.
    const moved = await withoutHistoryRecording(() => replayEntry(entry))
    if (!moved) return false
    useNavigationHistory.getState().move(delta)
    return true
  }
  return false
}

/** Jump directly to a history index (right-click menu): position the cursor, never push. */
export async function moveToHistoryIndex(index: number): Promise<boolean> {
  if (selectFileLocked(useUIStore.getState())) return false
  const history = useNavigationHistory.getState()
  const entry = history.entryAt(index)
  if (!entry) return false
  const stat = await window.api.documents.stat(entry.path)
  if (!stat?.exists) {
    history.prune(entry.path)
    return false
  }
  const moved = await withoutHistoryRecording(() => replayEntry(entry))
  if (!moved) return false
  history.setCursor(index)
  return true
}
