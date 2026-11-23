// ADR-0040: pure tab-list operations. Kept free of React/Zustand so every branch
// can be unit-tested at the lowest layer (docs/agents/testing.md's pyramid).

export interface Tab {
  id: string
  documentId: string
  /** Display-form title, mirrored into `activeDocumentTitle` on activation. */
  title: string
  editable: boolean
  isNewUnsaved: boolean
  /** Outside the window workspace root; badge shown by the tab strip. */
  external: boolean
}

export interface OpenTabOptions {
  activate?: boolean
  /** Stable identity supplied by a cross-window handoff; generated when absent. */
  tabId?: string
  title?: string
  editable?: boolean
  isNewUnsaved?: boolean
  external?: boolean
  /**
   * ADR-0041: `true` asks for the window's single replaceable (unpinned) tab; `false` asks to
   * make an existing unpinned tab permanent. Omitted means pinned — only explicit user
   * preview actions opt into the slot.
   */
  preview?: boolean
}

let tabCounter = 0

/** Deterministic-enough in-memory identity; tab ids never persist. */
export function nextTabId(): string {
  tabCounter += 1
  return `tab-${tabCounter}`
}

/** Test-only reset so id sequences stay stable across suites. */
export function __resetTabIdsForTests(): void {
  tabCounter = 0
}

export function findTabIndexById(tabs: readonly Tab[], tabId: string): number {
  return tabs.findIndex((tab) => tab.id === tabId)
}

export function findTabByDocumentId(tabs: readonly Tab[], documentId: string): Tab | undefined {
  return tabs.find((tab) => tab.documentId === documentId)
}

/**
 * Open a document as a tab. Reuses an existing tab for the SAME document id so a
 * link/sidebar click never duplicates an already-open document in the window.
 * Returns the id of the reused/created tab.
 */
export function openTabInList(
  tabs: readonly Tab[],
  documentId: string,
  options: OpenTabOptions = {},
): { tabs: Tab[]; tabId: string } {
  const existing = findTabByDocumentId(tabs, documentId)
  if (existing) return { tabs: [...tabs], tabId: existing.id }
  const tab: Tab = {
    id: options.tabId ?? nextTabId(),
    documentId,
    title: options.title ?? '',
    editable: options.editable ?? false,
    isNewUnsaved: options.isNewUnsaved ?? false,
    external: options.external ?? false,
  }
  return { tabs: [...tabs, tab], tabId: tab.id }
}

/** Neighbour to activate after removing the tab at `removedIndex`: right first, then left. */
export function neighbourAfterRemove(tabs: readonly Tab[], removedIndex: number): string | null {
  if (tabs.length === 0 || removedIndex < 0 || removedIndex >= tabs.length) return null
  return (tabs[removedIndex + 1] ?? tabs[removedIndex - 1] ?? null)?.id ?? null
}

export function removeTabFromList(
  tabs: readonly Tab[],
  tabId: string,
): { tabs: Tab[]; removedIndex: number; nextActiveId: string | null } {
  const index = findTabIndexById(tabs, tabId)
  if (index < 0) return { tabs: [...tabs], removedIndex: -1, nextActiveId: null }
  const nextActiveId = neighbourAfterRemove(tabs, index)
  return { tabs: tabs.filter((tab) => tab.id !== tabId), removedIndex: index, nextActiveId }
}

export function removeTabsFromList(tabs: readonly Tab[], tabIds: readonly string[]): Tab[] {
  if (tabIds.length === 0) return [...tabs]
  const remove = new Set(tabIds)
  return tabs.filter((tab) => !remove.has(tab.id))
}

/** Reorder a tab. Moving to its current index is an explicit no-op (new array, same order). */
export function moveTabInList(tabs: readonly Tab[], tabId: string, toIndex: number): Tab[] {
  const from = findTabIndexById(tabs, tabId)
  if (from < 0) return [...tabs]
  const target = Math.max(0, Math.min(tabs.length - 1, toIndex))
  if (from === target) return [...tabs]
  const next = [...tabs]
  const [tab] = next.splice(from, 1)
  next.splice(target, 0, tab)
  return next
}

export function replaceDocumentInList(
  tabs: readonly Tab[],
  tabId: string,
  newDocumentId: string,
): Tab[] {
  const index = findTabIndexById(tabs, tabId)
  if (index < 0) return [...tabs]
  return tabs.map((tab, i) => (i === index ? { ...tab, documentId: newDocumentId } : tab))
}

export function updateTabInList(
  tabs: readonly Tab[],
  tabId: string,
  patch: Partial<Omit<Tab, 'id'>>,
): Tab[] {
  const index = findTabIndexById(tabs, tabId)
  if (index < 0) return [...tabs]
  return tabs.map((tab, i) => (i === index ? { ...tab, ...patch } : tab))
}
