import { queryClient, DOCS_KEY } from './queryClient'
import { sameFilePath } from './previewLinkNavigation'
import { isInFolder } from '../../../../shared/fileUtils'
import { dirName } from './utils'
import { useUIStore, selectFileLocked } from '../store/ui'
import { useTabsStore } from '../store/tabs'
import {
  useNavigationHistory,
  withoutHistoryRecording,
  type NavigationEntry,
  type NavigationHistoryStore,
  type OpenMode,
} from '../store/navigationHistory'
import { getHistory } from '../store/tabHistory'
import { switchWorkspace } from './workspaceSwitch'

// One service owns "navigate to a document by path" inside the CURRENT workspace. Workspace
// switching is owned by switchWorkspace (double-click / ↑ / breadcrumb / external-link switch),
// and workspace-external links are dispatched by MarkdownPreview's four-way dialog. This function
// never replaces the workspace root. ADR-0040: each tab has its own history; when no tab is open
// (unit tests / startup) we fall back to the default store so legacy call sites still work.

export interface NavigateOptions {
  /** Back/Forward already owns the cursor and must not append a new entry. */
  record?: boolean
  openMode?: OpenMode
}

function activeHistory(): NavigationHistoryStore {
  return getHistory(useTabsStore.getState().activeTabId) ?? useNavigationHistory
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

  // ADR-0040: no closeDocument() — navigating opens/activates a tab and keeps every
  // other tab's draft intact. A navigation event is recorded in the target tab's own stack.
  const listed = await window.api.documents.list()
  const doc =
    listed.find((d) => sameFilePath(d.filePath, filePath)) ??
    (await window.api.documents.import(filePath, external ? { external: true } : undefined))
  if (!doc) return false
  const activeDoc = doc

  const tabId = useTabsStore.getState().activeTabId
  // Capture the document we are navigating FROM before the target tab is activated:
  // when the source was opened via the legacy setter (no tab), its path must still seed
  // the target tab's first history entry so Back can return to it (ADR-0040 §5.2).
  const fromId = ui.activeDocumentId
  const fromDoc = fromId && fromId !== activeDoc.id ? await window.api.documents.get(fromId) : null
  if (options.record === false) {
    await withoutHistoryRecording(() => activate(), tabId)
  } else {
    await activate()
  }

  async function activate(): Promise<void> {
    const tabs = useTabsStore.getState()
    const existingTab = tabs.tabs.find((tab) => tab.documentId === activeDoc.id)
    const targetTabId =
      existingTab?.id ?? tabs.openTab(activeDoc.id, { title: activeDoc.title, activate: false })
    const history = getHistory(targetTabId) ?? useNavigationHistory
    // A brand-new tab's first entry is the document it replaced, when known.
    if (!existingTab && fromDoc?.filePath && history.getState().entries.length === 0) {
      history.getState().push(fromDoc.filePath)
    }
    tabs.activateTab(targetTabId)
    if (options.record !== false) {
      history.getState().push(filePath, { openMode: options.openMode ?? 'in-place' })
    }
    useUIStore.getState().setDirty(false)
    useUIStore.getState().bumpDocumentState()
    queryClient.invalidateQueries({ queryKey: DOCS_KEY })
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
export async function replayEntry(entry: NavigationEntry): Promise<boolean> {
  if (entry.openMode === 'external-switch') {
    return switchWorkspace(dirName(entry.path), {
      openMode: 'external-switch',
      openPath: entry.path,
      title: entry.title,
      record: false,
      replayTabId: useTabsStore.getState().activeTabId,
    })
  }
  return navigateToPath(entry.path, { record: false, openMode: entry.openMode })
}

/** Move Back (-1) or Forward (1), skipping and pruning entries whose files no longer exist. */
export async function moveNavigationHistory(delta: -1 | 1): Promise<boolean> {
  if (selectFileLocked(useUIStore.getState())) return false
  const tabId = useTabsStore.getState().activeTabId
  const history = activeHistory()
  for (let guard = 0; guard <= history.getState().entries.length; guard += 1) {
    // Re-read the cursor every iteration: prune() can shift it, and a stale snapshot would keep
    // pruning the wrong (already-gone) index until the loop runs out.
    const current = history.getState()
    const targetIndex = delta === -1 ? current.cursor - 1 : current.cursor + 1
    const entry = current.entryAt(targetIndex)
    if (!entry) return false
    const stat = await window.api.documents.stat(entry.path)
    if (!stat?.exists) {
      current.prune(entry.path)
      continue
    }
    const moved = await withoutHistoryRecording(() => replayEntry(entry), tabId)
    if (!moved) return false
    history.getState().move(delta)
    return true
  }
  return false
}

/** Jump directly to a history index (right-click menu): position the cursor, never push. */
export async function moveToHistoryIndex(index: number): Promise<boolean> {
  if (selectFileLocked(useUIStore.getState())) return false
  const tabId = useTabsStore.getState().activeTabId
  const history = activeHistory()
  const entry = history.getState().entryAt(index)
  if (!entry) return false
  const stat = await window.api.documents.stat(entry.path)
  if (!stat?.exists) {
    history.getState().prune(entry.path)
    return false
  }
  const moved = await withoutHistoryRecording(() => replayEntry(entry), tabId)
  if (!moved) return false
  history.getState().setCursor(index)
  return true
}
