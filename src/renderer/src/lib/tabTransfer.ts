import type { TabHandoff } from '../../../../shared/tabTypes'
import { useTabsStore } from '../store/tabs'
import { useUIStore } from '../store/ui'
import { disposeHistory, seedHistory } from '../store/tabHistory'
import { DOCS_KEY, queryClient } from '../lib/queryClient'

// ADR-0040 §5.5.2: seed a destination tab from a complete handoff. The destination
// re-imports the file to get its own document id, but keeps the stable tab id and
// the whole history/draft so a cross-window move is a move, not a copy.

export async function acceptTabHandoff(handoff: TabHandoff): Promise<void> {
  // A detached window's main-process context already has the root (set by createWindow), but the
  // renderer store starts empty and only learns a root from an explicit folder-open. Mirror it
  // here so the destination shows the workspace, not just the tab (ADR-0040 §5.5.2).
  const root = await window.api?.documents?.getWorkspaceRoot?.()
  if (root) {
    useUIStore.getState().setWorkspaceRoot(root)
    // createWindow() set the root but imported no files. Hydrate the sidebar from that root
    // WITHOUT going through useOpenPaths, which would reset tabs/history and clear the draft
    // this handoff is carrying (ADR-0040 §5.5.2).
    const { markdownFiles } = await window.api.files.resolvePaths([root])
    if (markdownFiles.length > 0) await window.api.documents.importMany(markdownFiles)
  }
  let documentId: string
  if (handoff.filePath) {
    const doc = await window.api.documents.import(handoff.filePath, {
      external: handoff.external,
    })
    if (!doc) return
    documentId = doc.id
  } else {
    const doc = await window.api.documents.create({
      title: handoff.title || 'Untitled',
      memoryOnly: true,
    })
    documentId = doc.id
  }

  const tabs = useTabsStore.getState()
  const tabId = tabs.openTabWithId(handoff.tabId, documentId, {
    title: handoff.title,
    editable: false,
    isNewUnsaved: handoff.isNewUnsaved,
    external: handoff.external,
    activate: true,
    // ADR-0041: a transferred tab is explicit and must never remain replaceable in the target.
    preview: false,
  })
  seedHistory(tabId, handoff.history, handoff.cursor)
  if (handoff.content !== null) {
    useUIStore.getState().reportUnsavedBuffer(documentId, handoff.content, handoff.title)
    useUIStore.getState().setDirty(true)
  }
  // Mirroring the root switches the sidebar's query key, so a fetch for that key can start
  // BEFORE this import lands and cache an empty tree. Refresh once the document is in the
  // store; otherwise the window shows the folder bar but no files (ADR-0040 §5.5.2).
  await queryClient.invalidateQueries({ queryKey: DOCS_KEY })
  useUIStore.getState().bumpDocumentState()
}

/**
 * ADR-0040: consume the one-shot handoff at startup. There is deliberately NO cancellation
 * guard here: React StrictMode double-invokes effects, and `tabs:take-handoff` consumes the
 * pending entry on the FIRST call. Cancelling that call would throw the handoff away and leave
 * the new window blank; the second call simply sees null and is a no-op.
 */
export async function consumePendingTabHandoff(): Promise<void> {
  const pending = await window.api?.tabs?.takeHandoff?.()
  if (!pending) return
  await acceptTabHandoff(pending.handoff)
  await window.api.tabs.acceptAck(pending.token)
}

/** Remove a tab after the source received the destination ACK (main → renderer). */
export function removeTransferredTab(tabId: string): void {
  const store = useTabsStore.getState()
  const tab = store.tabs.find((item) => item.id === tabId)
  if (tab) useUIStore.getState().closeTabDocument(tab.documentId, tab.isNewUnsaved)
  store.closeTab(tabId)
  // ADR-0040 §5.5.2: the destination has ACKed, so the source copy's history is safe to release.
  disposeHistory(tabId)
}
