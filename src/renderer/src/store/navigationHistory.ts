import { create } from 'zustand'
import { sameFilePath } from '../lib/previewLinkNavigation'

// ADR-0038 §3.4: document navigations are keyed by ABSOLUTE FILE PATH (document ids are invalid
// after a workspace replacement). Entries live only for the app session. Browser semantics:
// pushing a new entry truncates the forward part; Back/Forward move a cursor without mutating
// entries. Missing files are pruned lazily by the navigation service when a move reaches them.

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
  reset: () => void
}

// Back/Forward activation changes the active document too. Suppress the automatic
// `setActiveDocumentId` recording while such a move is in flight, otherwise the cursor would be
// truncated as if the user had navigated somewhere new.
// A COUNTER, not a flag: the suppression nests (replaying an "external-switch" entry runs
// `switchWorkspace`, which suppresses its own recording while the outer move still runs). A
// boolean would be cleared by the inner block and re-enable recording for the rest of the
// outer one.
let recordingSuspended = 0

export function isHistoryRecordingSuspended(): boolean {
  return recordingSuspended > 0
}

export async function withoutHistoryRecording<T>(action: () => Promise<T>): Promise<T> {
  recordingSuspended += 1
  try {
    return await action()
  } finally {
    recordingSuspended -= 1
  }
}

export const useNavigationHistory = create<NavigationHistoryState>((set, get) => ({
  entries: [],
  cursor: -1,

  push: (filePath, meta) => {
    if (!filePath) return
    const { entries, cursor } = get()
    // The same file re-opened (sidebar click on the active doc, repeated link, Back landing
    // on its target) is NOT a new navigation.
    if (entries[cursor] && sameFilePath(entries[cursor].path, filePath)) return
    // Chrome records a new entry even when the target appeared earlier in the stack; only a
    // forward truncation happens here. A Back/Forward move uses the cursor, never push().
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

  entryAt: (index) => {
    const { entries } = get()
    return entries[index] ?? null
  },

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

  reset: () => set({ entries: [], cursor: -1 }),
}))

// e2e test hook: expose the real history store (dev only, tree-shaken from production).
// The `false` branch (production builds) is unreachable under unit tests because
// `import.meta.env.DEV` is inlined to `true` there; it is exercised by the production
// build instead. See the same pattern in store/ui.ts.
/* v8 ignore next 3 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __navHistory?: typeof useNavigationHistory }).__navHistory =
    useNavigationHistory
}
