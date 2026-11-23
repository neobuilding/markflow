import type { TabHandoff } from '../../../../shared/tabTypes'
import { useTabsStore } from '../store/tabs'
import { useUIStore } from '../store/ui'
import { getHistory } from '../store/tabHistory'

// ADR-0040 §6.2: build the complete in-memory state of a tab for cross-window transfer.
// Every field is required; a partial handoff would silently lose the draft title or history.

export async function buildTabHandoff(tabId: string): Promise<TabHandoff | null> {
  const tab = useTabsStore.getState().tabs.find((item) => item.id === tabId)
  if (!tab) return null
  const doc = await window.api.documents.get(tab.documentId)
  if (!doc) return null
  const buffer = useUIStore.getState().unsavedBuffers[tab.documentId]
  const history = getHistory(tabId)?.getState()
  // ADR-0042: the destination window starts its own global stack; transfer only the current
  // entry of the moved tab, not the source window's entire history.
  const entry = history?.entryAt(history.cursor)
  return {
    tabId,
    documentId: tab.documentId,
    filePath: doc.filePath,
    content: buffer ? buffer.content : null,
    title: buffer?.title ?? tab.title,
    external: !doc.filePath ? false : await isExternal(doc.filePath),
    isNewUnsaved: tab.isNewUnsaved,
    eol: doc.content.includes('\r\n') ? '\r\n' : '\n',
    history: entry ? [entry] : [],
    cursor: entry ? 0 : -1,
  }
}

async function isExternal(filePath: string): Promise<boolean> {
  const root = await window.api.documents.getWorkspaceRoot()
  if (!root) return false
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  return !normalize(filePath).startsWith(normalize(root).replace(/\/+$/, '') + '/')
}
