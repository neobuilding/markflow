import {
  createNavigationHistory,
  useNavigationHistory,
  type NavigationEntry,
  type NavigationHistoryState,
  type NavigationHistoryStore,
  type OpenMode,
} from './navigationHistory'
import { useTabsStore } from './tabs'

// ADR-0040 T6': one navigation history per tab. The map is module-level (in-memory only,
// never persisted) and keyed by the stable tab id, so detach/cross-window move can carry
// the same stack to the destination via an explicit history payload.

const histories = new Map<string, NavigationHistoryStore>()

export function createHistory(tabId: string): NavigationHistoryStore {
  let history = histories.get(tabId)
  if (!history) {
    history = createNavigationHistory()
    histories.set(tabId, history)
  }
  return history
}

export function getHistory(tabId: string | null): NavigationHistoryStore | undefined {
  return tabId ? histories.get(tabId) : undefined
}

/** Seed a destination tab's history from a handoff. Cursor is clamped by the store. */
export function seedHistory(
  tabId: string,
  entries: NavigationEntry[],
  cursor: number,
): NavigationHistoryStore {
  const history = createHistory(tabId)
  history.setState({ entries, cursor })
  return history
}

export function disposeHistory(tabId: string): void {
  histories.delete(tabId)
}

/** History of the active tab; callers that need it across awaits capture the tabId first. */
export function currentHistory(): NavigationHistoryStore | undefined {
  return getHistory(useTabsStore.getState().activeTabId)
}

/** Push to a specific tab (used by navigation services that know the target tab). */
export function pushTabHistory(
  tabId: string | null,
  path: string | null | undefined,
  meta?: { title?: string; openMode?: OpenMode },
): void {
  if (!tabId || !path) return
  createHistory(tabId).getState().push(path, meta)
}

/**
 * Reactive selector over the active tab's history. `activeTabId` is subscribed so a
 * tab switch re-renders; when no tab is open (tests/startup) the default store is used.
 */
export function useActiveTabHistory<T>(selector: (state: NavigationHistoryState) => T): T {
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const store = (activeTabId ? histories.get(activeTabId) : undefined) ?? useNavigationHistory
  return store(selector)
}

/** Test-only: drop all per-tab histories between suites. */
export function __resetTabHistoriesForTests(): void {
  histories.clear()
}
