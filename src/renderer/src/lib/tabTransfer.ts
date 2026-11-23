import type { TabHandoff } from '../../../../shared/tabTypes'
import { useTabsStore } from '../store/tabs'
import { useUIStore } from '../store/ui'
import { disposeHistory, seedHistory } from '../store/tabHistory'

// ADR-0040 §5.5.2: seed a destination tab from a complete handoff. The destination
// re-imports the file to get its own document id, but keeps the stable tab id and
// the whole history/draft so a cross-window move is a move, not a copy.

export async function acceptTabHandoff(handoff: TabHandoff): Promise<void> {
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
  useUIStore.getState().bumpDocumentState()
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
