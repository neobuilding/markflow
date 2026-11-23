import { queryClient, DOCS_KEY } from './queryClient'
import { sameFilePath } from './previewLinkNavigation'
import { isInFolder } from '../../../../shared/fileUtils'
import { dirName } from './utils'
import { useUIStore, selectFileLocked } from '../store/ui'
import { useTabsStore } from '../store/tabs'
import {
  useNavigationHistory,
  withoutHistoryRecording,
  type EditorPosition,
  type NavigationEntry,
  type NavigationHistoryStore,
  type OpenMode,
} from '../store/navigationHistory'
import { getHistory } from '../store/tabHistory'
import { switchWorkspace } from './workspaceSwitch'

// One service owns "navigate to a document by path" inside the CURRENT workspace. Workspace
// switching is owned by switchWorkspace (double-click / ↑ / breadcrumb / external-link switch),
// and workspace-external links are dispatched by MarkdownPreview's four-way dialog. This function
// never replaces the workspace root. ADR-0042: one global history stack per window; each entry
// records the tab that displayed the document and the editor range, so Back returns to a position.

export interface NavigateOptions {
  /** Back/Forward already owns the cursor and must not append a new entry. */
  record?: boolean
  openMode?: OpenMode
  /**
   * ADR-0041: open the target in the window's replaceable preview slot. A rendered Markdown preview
   * link does NOT pin the source: an unpinned source tab is reused, a pinned source is left alone.
   */
  preview?: boolean
  /** ADR-0042: tab recorded in the pushed entry; replay activates it when it still exists. */
  tabId?: string
  /** ADR-0042: editor range stored on the entry / restored when replaying. */
  position?: EditorPosition
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
  // other tab's draft intact. ADR-0042: the navigation is recorded in the ONE global stack.
  const listed = await window.api.documents.list()
  const doc =
    listed.find((d) => sameFilePath(d.filePath, filePath)) ??
    (await window.api.documents.import(filePath, external ? { external: true } : undefined))
  if (!doc) return false
  const activeDoc = doc

  const tabId = useTabsStore.getState().activeTabId
  const history = getHistory(tabId) ?? useNavigationHistory
  if (options.record !== false) history.getState().updateCurrentPosition(ui.editorSelection)
  // Capture the document we are navigating FROM before the target tab is activated:
  // when the source was opened via the legacy setter (no tab), its path must still seed
  // the first global entry so Back can return to it.
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
    // ADR-0041/0042: a preview open from the current preview tab reuses that tab id, so the
    // global stack and its cursor survive. A pinned source gets a new preview tab instead.
    // A history replay similarly reuses the tab recorded in the entry, even when that tab now
    // displays a different document — Back must return to the source in the same tab.
    const recordedTab = options.tabId
      ? tabs.tabs.find((item) => item.id === options.tabId)
      : undefined
    // Entries created before the workspace's first file was recorded have no tabId. When the
    // active tab is the preview slot, replay must reuse it instead of silently adding a tab.
    const previewTab =
      options.record === false && !!tabId && tabs.previewTabId === tabId
        ? tabs.tabs.find((item) => item.id === tabId)
        : undefined
    const replayTab = recordedTab ?? previewTab
    const previewReuse = options.preview === true && !!tabId && tabs.previewTabId === tabId
    const replayReuse = options.record === false && !!replayTab
    let targetTabId: string
    if (existingTab) {
      targetTabId = existingTab.id
    } else if (replayReuse && replayTab) {
      tabs.replaceDocument(replayTab.id, activeDoc.id)
      tabs.updateTab(replayTab.id, { title: activeDoc.title ?? '' })
      targetTabId = replayTab.id
    } else if (previewReuse && tabId) {
      tabs.replaceDocument(tabId, activeDoc.id)
      tabs.updateTab(tabId, { title: activeDoc.title ?? '' })
      targetTabId = tabId
    } else {
      targetTabId = tabs.openTab(activeDoc.id, {
        title: activeDoc.title,
        activate: false,
        preview: options.preview,
      })
    }
    const history = getHistory(tabId) ?? useNavigationHistory
    if (
      !existingTab &&
      !previewReuse &&
      !replayReuse &&
      fromDoc?.filePath &&
      history.getState().entries.length === 0
    ) {
      history.getState().push(fromDoc.filePath, { tabId: tabId ?? undefined })
    }
    tabs.activateTab(targetTabId)
    if (options.record !== false) {
      history.getState().push(filePath, {
        openMode: options.openMode ?? 'in-place',
        tabId: targetTabId,
        position: options.position,
      })
    } else if (options.position) {
      useUIStore.getState().setPendingMatch({ id: activeDoc.id, ...options.position })
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
    // ADR-0042 §3: restore the exact root recorded on the entry; older entries fall back to
    // the file's parent directory, which was the pre-replayRoot convention.
    return switchWorkspace(entry.replayRoot ?? dirName(entry.path), {
      openMode: 'external-switch',
      openPath: entry.path,
      title: entry.title,
      record: false,
      replayTabId: entry.tabId ?? useTabsStore.getState().activeTabId,
    })
  }
  return navigateToPath(entry.path, {
    record: false,
    openMode: entry.openMode,
    tabId: entry.tabId,
    position: entry.position,
  })
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
