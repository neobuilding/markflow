import type { TabHandoff } from '../../../../shared/tabTypes'
import { useTabsStore } from '../store/tabs'
import { useUIStore } from '../store/ui'
import { seedHistory } from '../store/tabHistory'

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
    activate: true,
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
  if (tab) useUIStore.getState().closeTabDocument(tab.documentId)
  store.closeTab(tabId)
}
