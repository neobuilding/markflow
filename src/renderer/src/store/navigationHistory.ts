import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { sameFilePath } from '../lib/previewLinkNavigation'

// ADR-0042: ONE global navigation stack per window (not one per tab). Entries are keyed by ABSOLUTE
// FILE PATH (document ids are invalid after a workspace replacement) and also record the tab that
// displayed the document and the editor character range at that point. Cursor moves update the
// current entry's position in place; a real navigation pushes a new entry and truncates the forward
// part. Missing files are pruned lazily by the navigation service when a move reaches them.

/** How the document at a history entry was opened; replayed by Back/Forward without re-prompting. */
export type OpenMode = 'in-place' | 'external-keep' | 'external-switch'

/** Editor character range restored by Back/Forward via `pendingMatch` (ADR-0042 §2). */
export interface EditorPosition {
  start: number
  end: number
}

export interface NavigationEntry {
  path: string
  title?: string
  openMode?: OpenMode
  /** ADR-0042: workspace root to restore when replaying a cross-switch entry. */
  replayRoot?: string
  tabId?: string
  position?: EditorPosition
}

export interface NavigationHistoryState {
  entries: NavigationEntry[]
  cursor: number
  push: (
    filePath: string | null | undefined,
    meta?: {
      title?: string
      openMode?: OpenMode
      replayRoot?: string
      tabId?: string | null
      position?: EditorPosition
    },
  ) => void
  /** A cursor move updates the current entry only; it never creates a history entry. */
  updateCurrentPosition: (position: EditorPosition | null) => void
  /** ADR-0042: make the current entry replayable across a workspace switch. */
  markCurrentEntryForSwitch: (root: string, tabId?: string | null) => void
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
// ADR-0042: there is one global stack, so suppression is global. The tabId argument is kept
// for call-site compatibility; it has no effect on the single global stack.
const globalSuspended = { depth: 0 }

export function isHistoryRecordingSuspended(_tabId?: string | null): boolean {
  return globalSuspended.depth > 0
}

export async function withoutHistoryRecording<T>(
  action: () => Promise<T>,
  _tabId?: string | null,
): Promise<T> {
  globalSuspended.depth += 1
  try {
    return await action()
  } finally {
    globalSuspended.depth -= 1
  }
}

/** Create an isolated navigation-history store (production uses the single default instance). */
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
        entries: [
          ...kept,
          {
            path: filePath,
            title: meta?.title,
            openMode: meta?.openMode,
            replayRoot: meta?.replayRoot,
            tabId: meta?.tabId ?? undefined,
            position: meta?.position,
          },
        ],
        cursor: kept.length,
      })
    },

    updateCurrentPosition: (position) =>
      set((s) => {
        const entry = s.entries[s.cursor]
        if (!entry) return s
        const entries = [...s.entries]
        entries[s.cursor] = { ...entry, position: position ?? undefined }
        return { entries }
      }),

    markCurrentEntryForSwitch: (root, tabId) =>
      set((s) => {
        const entry = s.entries[s.cursor]
        if (!entry) return s
        const entries = [...s.entries]
        entries[s.cursor] = {
          ...entry,
          openMode: 'external-switch',
          replayRoot: root,
          tabId: entry.tabId ?? tabId ?? undefined,
        }
        return { entries }
      }),

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

/** The single global navigation stack for a window (ADR-0042). */
export const useNavigationHistory = createNavigationHistory()

// e2e test hook: expose the real history store (dev only, tree-shaken from production).
/* v8 ignore next 3 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __navHistory?: typeof useNavigationHistory }).__navHistory =
    useNavigationHistory
}
