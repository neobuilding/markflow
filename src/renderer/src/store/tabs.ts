import { create } from 'zustand'
import {
  findTabIndexById,
  findTabByDocumentId,
  moveTabInList,
  openTabInList,
  removeTabFromList,
  removeTabsFromList,
  replaceDocumentInList,
  updateTabInList,
  type OpenTabOptions,
  type Tab,
} from '../lib/tabList'
import { useUIStore } from './ui'

// ADR-0040: renderer-owned tab list. The active tab id is the source of truth;
// `activeDocumentId` / `activeDocumentTitle` / `editable` / `isNewUnsaved` / `dirty`
// in ui.ts are mirrors written by `activateTab` so existing readers need no change.

export type { Tab } from '../lib/tabList'

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null

  openTab: (documentId: string, options?: OpenTabOptions) => string
  openTabWithId: (tabId: string, documentId: string, options?: OpenTabOptions) => string
  activateTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  replaceDocument: (tabId: string, newDocumentId: string) => void
  moveTab: (tabId: string, toIndex: number) => void
  removeTabs: (tabIds: string[]) => void
  updateTab: (tabId: string, patch: Partial<Omit<Tab, 'id'>>) => void
  reset: () => void
}

/** Mirror the active tab's identity/editor state into the UI store. */
function mirrorActiveTab(tab: Tab | undefined): void {
  const ui = useUIStore.getState()
  if (!tab) {
    ui.setActiveDocumentId(null)
    ui.setActiveDocumentTitle(null)
    ui.setEditable(false)
    ui.setIsNewUnsaved(false)
    ui.setDirty(false)
    return
  }
  ui.setActiveDocumentId(tab.documentId)
  ui.setActiveDocumentTitle(tab.title)
  ui.setEditable(tab.editable)
  ui.setIsNewUnsaved(tab.isNewUnsaved)
  ui.setDirty(ui.isTabDirty(tab.documentId))
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (documentId, options = {}) => {
    const { tabs, tabId } = openTabInList(get().tabs, documentId, options)
    set({ tabs })
    if (options.activate !== false) get().activateTab(tabId)
    return tabId
  },

  openTabWithId: (tabId, documentId, options = {}) => {
    const existing = findTabByDocumentId(get().tabs, documentId)
    const id = existing?.id ?? tabId
    let tabs = get().tabs
    if (!existing) {
      tabs = openTabInList(tabs, documentId, { ...options, tabId }).tabs
    } else {
      tabs = updateTabInList(tabs, id, options)
    }
    set({ tabs })
    if (options.activate !== false) get().activateTab(id)
    return id
  },

  activateTab: (tabId) => {
    const { tabs } = get()
    if (findTabIndexById(tabs, tabId) < 0) return
    set({ activeTabId: tabId })
    mirrorActiveTab(tabs.find((tab) => tab.id === tabId))
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get()
    const { tabs: next, removedIndex, nextActiveId } = removeTabFromList(tabs, tabId)
    if (removedIndex < 0) return
    set({ tabs: next, activeTabId: activeTabId === tabId ? nextActiveId : activeTabId })
    if (activeTabId === tabId) {
      mirrorActiveTab(next.find((tab) => tab.id === nextActiveId))
    }
  },

  replaceDocument: (tabId, newDocumentId) => {
    const tabs = replaceDocumentInList(get().tabs, tabId, newDocumentId)
    set({ tabs })
    if (get().activeTabId === tabId) {
      const ui = useUIStore.getState()
      ui.setActiveDocumentId(newDocumentId)
      ui.setDirty(ui.isTabDirty(newDocumentId))
    }
  },

  moveTab: (tabId, toIndex) => set((s) => ({ tabs: moveTabInList(s.tabs, tabId, toIndex) })),

  removeTabs: (tabIds) => {
    const { tabs, activeTabId } = get()
    const next = removeTabsFromList(tabs, tabIds)
    set({
      tabs: next,
      activeTabId: activeTabId && tabIds.includes(activeTabId) ? null : activeTabId,
    })
    if (activeTabId && tabIds.includes(activeTabId)) mirrorActiveTab(undefined)
  },

  updateTab: (tabId, patch) => {
    set((s) => ({ tabs: updateTabInList(s.tabs, tabId, patch) }))
    if (get().activeTabId === tabId) {
      const tab = get().tabs.find((t) => t.id === tabId)
      /* v8 ignore next -- an active tab always exists in the list */
      if (tab) mirrorActiveTab(tab)
    }
  },

  reset: () => {
    set({ tabs: [], activeTabId: null })
    mirrorActiveTab(undefined)
  },
}))

// e2e/dev hook: expose the tab store alongside __uiStore / __navHistory.
/* v8 ignore next 3 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __tabs?: typeof useTabsStore }).__tabs = useTabsStore
}
