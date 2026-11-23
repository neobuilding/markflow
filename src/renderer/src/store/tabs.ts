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
import { disposeHistory } from './tabHistory'
import { useUIStore } from './ui'

// ADR-0040 renderer-owned tab list + ADR-0041 single preview slot. `activeTabId` is the source
// of truth for the active document; `previewTabId` is the single replaceable tab in this window.
// `activeDocumentId` / `activeDocumentTitle` / `editable` / `isNewUnsaved` / `dirty` in ui.ts are
// mirrors written by `activateTab` so existing readers need no change. A tab is a preview iff its
// id equals `previewTabId`; pinned state is never stored twice on the tab itself.

export type { Tab } from '../lib/tabList'

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  previewTabId: string | null

  openTab: (documentId: string, options?: OpenTabOptions) => string
  openTabWithId: (tabId: string, documentId: string, options?: OpenTabOptions) => string
  activateTab: (tabId: string) => void
  pinTab: (tabId: string) => void
  pinTabByDocumentId: (documentId: string) => void
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

/**
 * Remove a replaced preview without a discard prompt. ADR-0041 pins dirty editors on the first
 * dirty transition; if an out-of-band path still left a dirty buffer, keeping it is safer than
 * losing the user's edits.
 */
function disposeReplacedPreview(tab: Tab): boolean {
  const ui = useUIStore.getState()
  if (ui.isTabDirty(tab.documentId)) return false
  ui.closeTabDocument(tab.documentId, tab.isNewUnsaved)
  disposeHistory(tab.id)
  return true
}

export const useTabsStore = create<TabsState>((set, get) => {
  /** Shared ADR-0041 open transition: explicit preview replaces the slot; everything else pins. */
  function openDocument(
    documentId: string,
    tabId: string | undefined,
    options: OpenTabOptions,
  ): string {
    const state = get()
    const existing = findTabByDocumentId(state.tabs, documentId)
    if (existing) {
      // openTabWithId is also the handoff/re-import path: an existing tab must pick up the new
      // document's title and flags, exactly as it did before ADR-0041.
      if (tabId !== undefined) set({ tabs: updateTabInList(state.tabs, existing.id, options) })
      if (options.preview === false && state.previewTabId === existing.id) {
        set({ previewTabId: null })
      }
      // Re-opening the current preview, or activating an already-pinned tab, never moves the slot.
      if (options.activate !== false) get().activateTab(existing.id)
      return existing.id
    }

    let tabs = state.tabs
    let previewTabId = state.previewTabId
    if (options.preview === true && state.previewTabId) {
      const previous = tabs.find((tab) => tab.id === state.previewTabId)
      if (previous) {
        if (disposeReplacedPreview(previous)) {
          tabs = removeTabFromList(tabs, previous.id).tabs
        } else {
          // Exception path: an unexpectedly dirty preview becomes pinned and survives.
          previewTabId = null
        }
      }
    }
    const opened = openTabInList(tabs, documentId, { ...options, tabId: tabId ?? options.tabId })
    tabs = opened.tabs
    if (options.preview === true) previewTabId = opened.tabId
    set({ tabs, previewTabId })
    if (options.preview === true && useUIStore.getState().isTabDirty(documentId)) {
      // Restored drafts are permanent: a tab that is already dirty must not be replaceable.
      set({ previewTabId: null })
    }
    if (options.activate !== false) get().activateTab(opened.tabId)
    return opened.tabId
  }

  return {
    tabs: [],
    activeTabId: null,
    previewTabId: null,

    openTab: (documentId, options = {}) => openDocument(documentId, undefined, options),

    openTabWithId: (tabId, documentId, options = {}) => openDocument(documentId, tabId, options),

    activateTab: (tabId) => {
      const { tabs } = get()
      if (findTabIndexById(tabs, tabId) < 0) return
      set({ activeTabId: tabId })
      mirrorActiveTab(tabs.find((tab) => tab.id === tabId))
    },

    pinTab: (tabId) => {
      if (get().previewTabId === tabId) set({ previewTabId: null })
    },

    pinTabByDocumentId: (documentId) => {
      const state = get()
      if (!state.previewTabId) return
      const tab = state.tabs.find((item) => item.id === state.previewTabId)
      if (tab?.documentId === documentId) set({ previewTabId: null })
    },

    closeTab: (tabId) => {
      const { tabs, activeTabId, previewTabId } = get()
      const { tabs: next, removedIndex, nextActiveId } = removeTabFromList(tabs, tabId)
      if (removedIndex < 0) return
      set({
        tabs: next,
        activeTabId: activeTabId === tabId ? nextActiveId : activeTabId,
        previewTabId: previewTabId === tabId ? null : previewTabId,
      })
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

    moveTab: (tabId, toIndex) => {
      // ADR-0041: moving a tab is an explicit commitment to keep it.
      const { previewTabId } = get()
      set({
        tabs: moveTabInList(get().tabs, tabId, toIndex),
        previewTabId: previewTabId === tabId ? null : previewTabId,
      })
    },

    removeTabs: (tabIds) => {
      const { tabs, activeTabId, previewTabId } = get()
      const next = removeTabsFromList(tabs, tabIds)
      set({
        tabs: next,
        activeTabId: activeTabId && tabIds.includes(activeTabId) ? null : activeTabId,
        previewTabId: previewTabId && tabIds.includes(previewTabId) ? null : previewTabId,
      })
      if (activeTabId && tabIds.includes(activeTabId)) mirrorActiveTab(undefined)
    },

    updateTab: (tabId, patch) => {
      set((s) => ({ tabs: updateTabInList(s.tabs, tabId, patch) }))
      if (get().activeTabId === tabId) {
        const tab = get().tabs.find((t) => t.id === tabId)
        /* v8 ignore next -- unreachable by unit tests: set() above guarantees the active id is in tabs; retained for IPC safety and covered by tab-bar interaction tests */
        if (tab) mirrorActiveTab(tab)
      }
    },

    reset: () => {
      set({ tabs: [], activeTabId: null, previewTabId: null })
      mirrorActiveTab(undefined)
    },
  }
})

// e2e/dev hook: expose the tab store alongside __uiStore / __navHistory.
/* v8 ignore next 3 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __tabs?: typeof useTabsStore }).__tabs = useTabsStore
}
