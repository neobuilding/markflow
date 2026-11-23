import { queryClient, DOCS_KEY } from './queryClient'
import { arePathsSame, isDirInFolder, isInFolder } from '../../../../shared/fileUtils'
import { pathCaseSensitive } from './utils'
import { isMemoryOnly } from './sidebarDrafts'
import { useUIStore, selectFileLocked } from '../store/ui'
import {
  useNavigationHistory,
  withoutHistoryRecording,
  type OpenMode,
} from '../store/navigationHistory'
import { getHistory } from '../store/tabHistory'
import { useTabsStore } from '../store/tabs'
import { t } from '../i18n'
import { showCloseAllTabsDialog } from './closeTabDialog'

export interface SwitchWorkspaceOptions {
  /** How the resulting navigation was opened; replayed verbatim by Back/Forward. */
  openMode?: OpenMode
  /**
   * Open this file as the active document right after the swap. It is the "switch workspace"
   * exit of the four-way external-file dialog: the user picked a file OUTSIDE the current
   * workspace and asked for it to be opened HERE with the workspace moved to its folder.
   * With tabs, an explicit `replayTabId` means this target replaces that tab's document.
   */
  openPath?: string
  /** Title stored in the history entry (shown in the history menu). */
  title?: string
  /**
   * Record the resulting navigation in the history. False while REPLAYING an existing entry
   * (Back/Forward move the cursor, they never append).
   */
  record?: boolean
  /** Replaying an external-switch entry reuses this tab instead of opening a new one. */
  replayTabId?: string | null
  /** Root to restore when the resulting entry is replayed (ADR-0042 §3). */
  replayRoot?: string
}

interface KeptTab {
  tabId: string
  documentId: string
  path: string
  title: string
  buffer?: { content: string; title?: string; revision: number }
}

/**
 * Switch the entire workspace to `nextRoot` (double-click a subfolder, ↑, breadcrumb, or the
 * "switch workspace" choice of the external-link dialog). One service owns the whole transaction:
 * capability lock, conditional unsaved guard, the store/watcher swap, keeping/closing EVERY tab,
 * and one history entry for the resulting navigation.
 *
 * ADR-0040 §5.4: when a tab's document is still inside `nextRoot` it is re-imported (the store is
 * cleared by the swap) and its unsaved buffer is migrated to the new id. Out-of-root tabs are
 * closed after ONE aggregate prompt if any of them is dirty. The legacy no-tab path keeps the
 * existing single-document contract for older callers/tests.
 */
export async function switchWorkspace(
  nextRoot: string,
  options: SwitchWorkspaceOptions = {},
): Promise<boolean> {
  const ui = useUIStore.getState()
  if (selectFileLocked(ui)) return false

  const tabs = useTabsStore.getState().tabs
  const activeId = ui.activeDocumentId
  const targetPath = options.openPath ?? null
  const replayTabId = options.replayTabId ?? null

  // A no-tab renderer uses the pre-ADR-0040 single-document path; the new multi-tab path below
  // only runs when the window actually has tabs, so legacy callers keep their exact semantics.
  if (tabs.length === 0) {
    const current = activeId ? await window.api.documents.get(activeId) : null
    const currentPath = current?.filePath && !isMemoryOnly(current) ? current.filePath : null
    const willKeep = !!currentPath && isInFolder(currentPath, nextRoot)
    const keepCurrent = !targetPath && willKeep
    if (!keepCurrent && !(await useUIStore.getState().guardUnsavedSwitch())) return false
    const buffer =
      keepCurrent && currentPath && activeId
        ? useUIStore.getState().unsavedBuffers[activeId]
        : undefined
    if (!keepCurrent) useUIStore.getState().closeDocument()
    const pathToKeep = keepCurrent ? currentPath : null
    const tabId: string | null = useTabsStore.getState().activeTabId
    // ADR-0042 §2: a workspace switch is a navigation point — capture where the editor was.
    if (options.record !== false) {
      useNavigationHistory.getState().updateCurrentPosition(useUIStore.getState().editorSelection)
    }
    // The tab that will DISPLAY the pushed entry (a fresh openTab here, since none existed).
    let displayedTabId: string | null = null
    const opened = await withoutHistoryRecording(async () => {
      await window.api.documents.setWorkspaceRoot(nextRoot)
      useUIStore.getState().setWorkspaceRoot(nextRoot)
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
      if (targetPath) {
        const doc = await window.api.documents.import(targetPath)
        if (doc) {
          // No tab existed before the switch; opening the imported doc recreates the
          // pre-ADR single-document state for legacy callers. Without an active document
          // no tab is created (ADR-0040 §3.2) and the entry is recorded tab-less.
          if (activeId)
            displayedTabId = useTabsStore.getState().openTab(doc.id, {
              title: doc.title,
              preview: true,
            })
          return { path: targetPath, title: doc.title }
        }
      }
      if (pathToKeep) {
        const doc = await window.api.documents.import(pathToKeep)
        if (doc) {
          displayedTabId = useTabsStore
            .getState()
            .openTab(doc.id, { title: doc.title, preview: true })
          if (buffer) {
            useUIStore
              .getState()
              .reportUnsavedBuffer(doc.id, buffer.content, buffer.title ?? doc.title)
            useUIStore.getState().setDirty(true)
          }
          return { path: pathToKeep, title: doc.title }
        }
        useUIStore.getState().closeDocument()
      }
      return null
    })
    useUIStore.getState().bumpDocumentState()
    queryClient.invalidateQueries({ queryKey: DOCS_KEY })
    if (opened && options.record !== false) {
      const history = getHistory(tabId ?? '') ?? useNavigationHistory
      history.getState().push(opened.path, {
        openMode: options.openMode ?? 'in-place',
        replayRoot:
          options.replayRoot ?? (options.openMode === 'external-switch' ? nextRoot : undefined),
        title: opened.title,
        tabId: displayedTabId ?? tabId,
      })
    }
    return true
  }

  // Snapshot every tab's document and buffer BEFORE any await: each keystroke replaces
  // `unsavedBuffers` wholesale, so a stale snapshot would silently drop late edits.
  const snapshots = await Promise.all(
    tabs.map(async (tab) => ({
      tab,
      doc: await window.api.documents.get(tab.documentId),
      buffer: useUIStore.getState().unsavedBuffers[tab.documentId],
    })),
  )
  const kept: KeptTab[] = []
  const closing: typeof tabs = []
  for (const { tab, doc, buffer } of snapshots) {
    const path = doc?.filePath && !isMemoryOnly(doc) ? doc.filePath : null
    const isReplayTarget = replayTabId === tab.id && !!targetPath
    if (isReplayTarget) {
      // The replay target is replaced by the explicit openPath below. Keep the stable tab id
      // alive; closing it here would force a NEW tab and break Back/Forward replay.
    } else if (path && isInFolder(path, nextRoot)) {
      kept.push({ tabId: tab.id, documentId: tab.documentId, path, title: tab.title, buffer })
    } else {
      closing.push(tab)
    }
  }
  const dirtyClosing = closing.filter((tab) => useUIStore.getState().isTabDirty(tab.documentId))
  if (dirtyClosing.length > 0) {
    if (
      !(await showCloseAllTabsDialog(
        dirtyClosing.map((tab) => tab.title),
        t,
      ))
    )
      return false
  }

  const activeTabId = useTabsStore.getState().activeTabId
  for (const tab of closing) {
    useUIStore.getState().closeTabDocument(tab.documentId, tab.isNewUnsaved)
  }
  useTabsStore.getState().removeTabs(closing.map((tab) => tab.id))

  // ADR-0042 §2: a workspace switch is a navigation point — capture where the editor was.
  if (options.record !== false) {
    useNavigationHistory.getState().updateCurrentPosition(useUIStore.getState().editorSelection)
  }
  // ADR-0042: ONE global stack — prune once, not once per tab.
  useNavigationHistory.getState().pruneOutOfRoot(nextRoot)
  // The tab that will DISPLAY the pushed entry: the replay target, a fresh preview tab,
  // or the kept active tab when no explicit target was named.
  let displayedTabId: string | null = null
  const opened = await withoutHistoryRecording(async () => {
    await window.api.documents.setWorkspaceRoot(nextRoot)
    useUIStore.getState().setWorkspaceRoot(nextRoot)

    const { markdownFiles } = await window.api.files.resolvePaths([nextRoot])
    const caseSensitive = pathCaseSensitive()
    const forwardSlashes = (path: string) => path.replace(/\\/g, '/')
    const occupied = [...kept.map((tab) => tab.path), ...(targetPath ? [targetPath] : [])]
    const backfill = markdownFiles.filter((file) => {
      if (!isDirInFolder(file, nextRoot)) return false
      const normalized = forwardSlashes(file)
      return !occupied.some((path) => arePathsSame(normalized, forwardSlashes(path), caseSensitive))
    })
    await window.api.documents.importMany(backfill)

    // Re-import kept tabs one by one so each document id is fresh in the swapped store.
    for (const item of kept) {
      const doc = await window.api.documents.import(item.path)
      if (!doc) {
        useUIStore.getState().clearUnsavedBuffer(item.documentId)
        useTabsStore.getState().closeTab(item.tabId)
        continue
      }
      const tabsStore = useTabsStore.getState()
      tabsStore.replaceDocument(item.tabId, doc.id)
      tabsStore.updateTab(item.tabId, { title: doc.title, external: false })
      const buffer = useUIStore.getState().unsavedBuffers[item.documentId]
      useUIStore.getState().clearUnsavedBuffer(item.documentId)
      if (buffer) {
        useUIStore
          .getState()
          .reportUnsavedBuffer(doc.id, buffer.content, buffer.title || item.title || doc.title)
      }
    }

    if (targetPath) {
      const doc = await window.api.documents.import(targetPath)
      if (doc) {
        const tabsStore = useTabsStore.getState()
        if (replayTabId && tabsStore.tabs.some((tab) => tab.id === replayTabId)) {
          tabsStore.replaceDocument(replayTabId, doc.id)
          tabsStore.updateTab(replayTabId, { title: doc.title, external: false })
          displayedTabId = replayTabId
        } else {
          displayedTabId = tabsStore.openTab(doc.id, { title: doc.title, preview: true })
        }
        return { path: targetPath, title: doc.title }
      }
    }

    const active = useTabsStore.getState().tabs.find((tab) => tab.id === activeTabId)
    const activeDoc = active ? await window.api.documents.get(active.documentId) : null
    if (active && activeDoc?.filePath) return { path: activeDoc.filePath, title: active.title }
    return null
  })

  useUIStore.getState().bumpDocumentState()
  queryClient.invalidateQueries({ queryKey: DOCS_KEY })
  if (opened && options.record !== false) {
    const history = getHistory(activeTabId ?? '') ?? useNavigationHistory
    history.getState().push(opened.path, {
      openMode: options.openMode ?? 'in-place',
      replayRoot:
        options.replayRoot ?? (options.openMode === 'external-switch' ? nextRoot : undefined),
      title: opened.title,
      tabId: displayedTabId ?? activeTabId,
    })
  }
  return true
}
