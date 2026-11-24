import {
  useNavigationHistory,
  type NavigationEntry,
  type NavigationHistoryState,
  type NavigationHistoryStore,
  type OpenMode,
} from './navigationHistory'

// ADR-0042: one global navigation stack per window. The tabId-keyed API is retained so existing
// call sites keep their signatures, but every call resolves to the same store and records the tab
// id in the entry. `createNavigationHistory()` remains available for isolated unit tests only.

export function createHistory(_tabId: string): NavigationHistoryStore {
  return useNavigationHistory
}

export function getHistory(tabId: string | null): NavigationHistoryStore | undefined {
  return tabId ? useNavigationHistory : undefined
}

/** Seed the global stack from a handoff or a test. Cursor is clamped by the store. */
export function seedHistory(
  _tabId: string,
  entries: NavigationEntry[],
  cursor: number,
): NavigationHistoryStore {
  useNavigationHistory.setState({ entries, cursor })
  return useNavigationHistory
}

/** ADR-0042: no per-tab stack to release; ordinary tab close never prunes global entries. */
export function disposeHistory(_tabId: string): void {
  // Intentionally empty: paths are durable and a replay of a stale entry opens a new tab.
}

/** The global history store (the tabId argument is kept for call-site compatibility). */
export function currentHistory(): NavigationHistoryStore {
  return useNavigationHistory
}

/** Push to the global stack, recording which tab displayed the document. */
export function pushTabHistory(
  tabId: string | null,
  path: string | null | undefined,
  meta?: {
    title?: string
    openMode?: OpenMode
    replayRoot?: string
    position?: { start: number; end: number }
  },
): void {
  if (!tabId || !path) return
  useNavigationHistory.getState().push(path, { ...meta, tabId })
}

/** Reactive selector over the global history stack. */
export function useActiveTabHistory<T>(selector: (state: NavigationHistoryState) => T): T {
  return useNavigationHistory(selector)
}

/** Test-only: reset the global stack between suites. */
export function __resetTabHistoriesForTests(): void {
  useNavigationHistory.getState().reset()
}
