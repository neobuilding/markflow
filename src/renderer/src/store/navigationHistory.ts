import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { sameFilePath } from '../lib/previewLinkNavigation'

// ADR-0038 §3.4: document navigations are keyed by ABSOLUTE FILE PATH (document ids are invalid
// after a workspace replacement). Entries live only for the app session. Browser semantics:
// pushing a new entry truncates the forward part; Back/Forward move a cursor without mutating
// entries. Missing files are pruned lazily by the navigation service when a move reaches them.
// ADR-0040: per-tab instances; the default export stays for the pre-tab tests/flows.

/** How the document at a history entry was opened; replayed by Back/Forward without re-prompting. */
export type OpenMode = 'in-place' | 'external-keep' | 'external-switch'

export interface NavigationEntry {
  path: string
  title?: string
  openMode?: OpenMode
}

export interface NavigationHistoryState {
  entries: NavigationEntry[]
  cursor: number
  push: (
    filePath: string | null | undefined,
    meta?: { title?: string; openMode?: OpenMode },
  ) => void
  previous: () => string | null
  next: () => string | null
  entryAt: (index: number) => NavigationEntry | null
  /** Move the cursor one entry back (-1) or forward (1). Call only after a successful move. */
  move: (delta: -1 | 1) => void
  setCursor: (index: number) => void
  /** Remove the entry at `path` (used when a file no longer exists). */
  prune: (path: string) => void
  /** Remove out-of-root `in-place` entries after a workspace switch (ADR-0040 §5.4). */
  pruneOutOfRoot: (root: string) => void
  reset: () => void
}

export type NavigationHistoryStore = UseBoundStore<StoreApi<NavigationHistoryState>>

// A COUNTER, not a flag: suppression nests (replaying an "external-switch" entry runs
// `switchWorkspace`, which suppresses its own recording while the outer move still runs).
// ADR-0040 T15 adds per-tab counters so a suppressed replay on one tab cannot silence
// navigation pushes on another. The global counter remains the escape valve for a whole
// store-clear transaction (workspace switch) and for legacy call sites.
const globalSuspended = { depth: 0 }
const perTabSuspended = new Map<string, number>()

export function isHistoryRecordingSuspended(tabId?: string | null): boolean {
  if (!tabId) return globalSuspended.depth > 0
  return globalSuspended.depth > 0 || (perTabSuspended.get(tabId) ?? 0) > 0
}

export async function withoutHistoryRecording<T>(
  action: () => Promise<T>,
  tabId?: string | null,
): Promise<T> {
  if (!tabId) globalSuspended.depth += 1
  else perTabSuspended.set(tabId, (perTabSuspended.get(tabId) ?? 0) + 1)
  try {
    return await action()
  } finally {
    if (!tabId) globalSuspended.depth -= 1
    else {
      // The increment above always created the entry, so a direct read is safe here.
      /* v8 ignore next */
      const next = (perTabSuspended.get(tabId) ?? 1) - 1
      if (next <= 0) perTabSuspended.delete(tabId)
      else perTabSuspended.set(tabId, next)
    }
  }
}

/** Create an isolated navigation-history store (one per tab). */
export function createNavigationHistory(): NavigationHistoryStore {
  return create<NavigationHistoryState>((set, get) => ({
    entries: [],
    cursor: -1,

    push: (filePath, meta) => {
      if (!filePath) return
      const { entries, cursor } = get()
      // The same file re-opened (sidebar click on the active doc, repeated link, Back landing
      // on its target) is NOT a new navigation.
      if (entries[cursor] && sameFilePath(entries[cursor].path, filePath)) return
      const kept = entries.slice(0, cursor + 1)
      set({
        entries: [...kept, { path: filePath, title: meta?.title, openMode: meta?.openMode }],
        cursor: kept.length,
      })
    },

    previous: () => {
      const { entries, cursor } = get()
      return cursor > 0 ? (entries[cursor - 1]?.path ?? null) : null
    },

    next: () => {
      const { entries, cursor } = get()
      return cursor >= 0 && cursor < entries.length - 1 ? (entries[cursor + 1]?.path ?? null) : null
    },

    entryAt: (index) => get().entries[index] ?? null,

    move: (delta) =>
      set((s) => ({ cursor: Math.max(0, Math.min(s.entries.length - 1, s.cursor + delta)) })),

    setCursor: (index) =>
      set((s) => ({ cursor: Math.max(0, Math.min(s.entries.length - 1, index)) })),

    prune: (path) =>
      set((s) => {
        const kept = s.entries.filter((entry) => !sameFilePath(entry.path, path))
        if (kept.length === s.entries.length) return s
        return { entries: kept, cursor: Math.min(s.cursor, kept.length - 1) }
      }),

    pruneOutOfRoot: (root) =>
      set((s) => {
        // Only in-place entries become unreplayable after a root swap; external-keep and
        // external-switch entries carry their own open mode and can be replayed verbatim.
        const kept = s.entries.filter(
          (entry) =>
            (entry.openMode !== undefined && entry.openMode !== 'in-place') ||
            isInRoot(entry.path, root),
        )
        if (kept.length === s.entries.length) return s
        return { entries: kept, cursor: Math.min(s.cursor, kept.length - 1) }
      }),

    reset: () => set({ entries: [], cursor: -1 }),
  }))
}

/** Cheap root containment check, mirroring `isInFolder`'s separator folding. */
function isInRoot(filePath: string, root: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const file = normalize(filePath)
  const folder = normalize(root)
  return file.startsWith(folder + '/')
}

/** Default instance for legacy consumers and tests that predate per-tab history. */
export const useNavigationHistory = createNavigationHistory()

// e2e test hook: expose the real history store (dev only, tree-shaken from production).
/* v8 ignore next 3 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __navHistory?: typeof useNavigationHistory }).__navHistory =
    useNavigationHistory
}
