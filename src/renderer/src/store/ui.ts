import { create } from 'zustand'
import type { ViewMode, ThemeMode } from '../types'
import { resolveInitialLanguage, setStoredLanguage, type Locale } from '../i18n/storage'
import { t } from '../i18n/translate'
import { queryClient, DOCS_KEY } from '../lib/queryClient'

// Cross-component bridge for file actions requested from a different component than the
// one that performs them . Today only `rename` is used: the sidebar's
// "Rename" menu item (which lives in `Sidebar`) asks the editor (`EditorPane`) to enter
// its title-edit state. M2/M3 will extend this union with `save` / `saveAs` / `reload`
// the consumer effect already narrows on `type: 'rename'`
export type FileAction = { type: 'rename'; id: string } | { type: 'save' | 'saveAs' | 'reload' }

// Remove a memory-only draft (never saved to disk) and refresh the document list so the
// sidebar no longer shows the orphan draft
function deleteUnsavedDraft(id: string) {
  return window.api.documents.delete(id).finally(() => {
    queryClient.invalidateQueries({ queryKey: DOCS_KEY })
  })
}

// Drop the main process's workspace root (document store cleared + watcher stopped). Best-effort
// and fire-and-forget: closing the workspace must never be blocked by it.
function clearWorkspaceRoot() {
  try {
    void Promise.resolve(window.api.documents.setWorkspaceRoot(null)).catch(() => {})
  } catch {
    // Nothing to tear down; the watcher is discarded when the app quits anyway.
  }
}

// Ask the user whether the unsaved edits of `title` may be thrown away.
// Resolves true = discard and continue, false = keep editing (cancel the switch).
async function confirmDiscard(title: string): Promise<boolean> {
  try {
    const ok = await window.api.dialog.confirm({
      message: t('app.unsavedSwitch', { title }),
      okText: t('app.confirmDiscard'),
      cancelText: t('app.confirmKeep'),
    })
    return ok === true
  } catch {
    // No dialog available (unit test / preload missing): never discard silently.
    return false
  }
}

// "Keep editing" must put the cursor back where the unsaved text is, not leave it on the search
// row or tree item the user just clicked — otherwise the edit they chose to keep is off-screen and
// looks lost.
function focusEditorPane(): void {
  document.dispatchEvent(new CustomEvent('editor:focus-request'))
}

interface UnsavedBuffer {
  content: string
  revision: number
}

interface UIState {
  // Sidebar
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void

  // Which surface the sidebar shows. The two are mutually exclusive (ADR-0023): the Search view
  // needs the whole panel for its query / replace / scope rows and its hit list, which a 240px
  // sidebar cannot also give to the file tree.
  sidebarView: 'files' | 'search'
  setSidebarView: (view: 'files' | 'search') => void

  // Sidebar folder filtering. OFF (the default) shows only folders that transitively hold a
  // Markdown document; ON seeds the tree from the on-disk directory listing so folders
  // without Markdown appear too. In-memory only: no setting is ever persisted, so the app
  // always restarts on the clean default.
  showAllFolders: boolean
  setShowAllFolders: (v: boolean) => void
  toggleShowAllFolders: () => void

  // Folders created during this session. A brand-new folder is empty, so the filter above
  // would hide it the instant it is made; these are pinned visible until the folder gains
  // its first Markdown document (or until the app restarts).
  recentlyCreatedFolders: ReadonlySet<string>
  markFolderCreated: (path: string) => void
  clearCreatedFolder: (path: string) => void

  // Active document
  activeDocumentId: string | null
  // RAW switch, no guard. Callers MUST have already obtained the user's discard confirmation (or
  // be performing a flow where discarding is the point, e.g. close / close-workspace).
  setActiveDocumentId: (id: string | null) => void
  // Title of the active document, mirrored so the unsaved-switch prompt can NAME the document
  // being left (`app.unsavedSwitch` carries `{{title}}`).
  activeDocumentTitle: string | null
  setActiveDocumentTitle: (title: string | null) => void

  /**
   * Ask before any action that would throw away the active document's unsaved edits. Resolves
   * true when the action may proceed, false when the user chose to keep editing (in which case
   * the caller must do nothing at all).
   *
   * Split out of `selectDocument` because some flows must be guarded BEFORE the thing they are
   * about to create exists — a new document has no id yet, so there is nothing to "switch to"
   * and `selectDocument` cannot be called (ADR-0023 §5.9). Those flows call this, and only then
   * produce their side effect.
   */
  guardUnsavedSwitch: () => Promise<boolean>

  /**
   * Switch documents, guarding unsaved edits. Resolves true when the switch happened, false when
   * the user chose to keep editing (in which case nothing changes).
   *
   * This is the ONLY sanctioned entry point for user-initiated switches (ADR-0023). MarkFlow is
   * single-active-document: unsaved text lives in the editor's CodeMirror instance, so switching
   * away is unrecoverable. VS Code can skip the prompt because it keeps a dirty working copy per
   * document; MarkFlow has no such buffer, so the guard has to live here — one place, covering
   * every entry point, rather than a wrapper each call site may forget.
   */
  selectDocument: (id: string) => Promise<boolean>
  /** Switch and jump to a hit. Only writes `pendingMatch` once the guard has passed. */
  openDocumentAt: (id: string, start: number, end: number) => Promise<boolean>

  // Active folder (the opened folder / the folder of the opened file)
  activeFolder: string | null
  setActiveFolder: (folder: string | null) => void

  // Edit mode: false = read-only (default), true = editable
  editable: boolean
  setEditable: (editable: boolean) => void
  toggleEditable: () => void

  // Close only the current file (keep the opened folder / sidebar)
  closeDocument: () => void

  // Close the current file + folder → back to an empty workspace
  closeWorkspace: () => void

  // Whether the current document is an unsaved new document created in-app: the
  // first Save should prompt for a path (Save As) instead of overwriting the
  // default-location file. Cleared after a successful Save As.
  isNewUnsaved: boolean
  setIsNewUnsaved: (v: boolean) => void

  // View mode
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void

  // ─── Search view (Ctrl/Cmd+Shift+F): Markdown body search + scope + replace ──────────────
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  /** Comma-separated include patterns (relative to the workspace root). */
  searchInclude: string
  setSearchInclude: (v: string) => void
  /** Comma-separated exclude patterns. */
  searchExclude: string
  setSearchExclude: (v: string) => void
  /** Match Case (`Aa`). Defaults to OFF = case-insensitive, exactly like VS Code (D16). */
  searchMatchCase: boolean
  setSearchMatchCase: (v: boolean) => void
  /** Whole word (`ab`). Defaults to OFF; UAX #29 boundaries, so it works for CJK too (D34/D35). */
  searchWholeWord: boolean
  setSearchWholeWord: (v: boolean) => void
  /** Regexp (`.*`). Defaults to OFF — the query is one literal phrase unless asked (D30). */
  searchRegexp: boolean
  setSearchRegexp: (v: boolean) => void
  searchReplaceText: string
  setSearchReplaceText: (v: string) => void
  /** The replace row is hidden behind a chevron by default (D5). */
  searchReplaceOpen: boolean
  setSearchReplaceOpen: (v: boolean) => void
  /** The include/exclude details block. Collapsed by default, forced open when non-empty. */
  searchDetailsOpen: boolean
  setSearchDetailsOpen: (v: boolean) => void
  // Bumped whenever a global shortcut (Ctrl+Shift+F) opens the Search view, so the input
  // can grab focus without the caller knowing the DOM (ADR-0023).
  searchFocusNonce: number
  requestSearchFocus: () => void
  // Bumped when the scope was set from somewhere else — the tree's "Search in This Folder" context
  // item — so the include row can grab focus. A caller across the component boundary cannot reach
  // the input element, and the row only mounts once the details block is open (ADR-0023 D8).
  searchScopeFocusNonce: number
  requestScopeFocus: () => void
  // Bumped when a global shortcut (Ctrl/Cmd+Shift+E) switches to the Files view, so the panel can
  // take focus. Explicit on purpose: an effect that moved focus on EVERY view change would also
  // fire for switches that already placed focus themselves ("Search in This Folder" parks the
  // caret in the include row) and for activity-bar clicks, where ARIA APG wants focus to STAY on
  // the tab. Only a caller that actually wants the panel asks for it.
  panelFocusNonce: number
  requestPanelFocus: () => void

  // Pending hit to jump to after a document opens. Set when a Search view hit is clicked; the
  // editor consumes it (selects + scrolls to the offset) once the document content has loaded,
  // then clears it.
  pendingMatch: { id: string; start: number; end: number } | null
  setPendingMatch: (m: { id: string; start: number; end: number } | null) => void

  // ─── Unsaved buffer registry (ADR-0023) ─────────────────────────────────────────────────
  //
  // The main process cannot discover unsaved edits: its store holds the bytes last read from
  // disk, so reading the file back always "matches". Content search and the replace pipeline
  // therefore need the renderer to report them, for EVERY dirty document (not just the active
  // one — that restriction is exactly what would silently overwrite a background edit).
  unsavedBuffers: Record<string, UnsavedBuffer>
  /** Bumped on every change to that registry. Sent to the main process as a tamper check. */
  documentStateRevision: number
  reportUnsavedBuffer: (id: string, content: string) => void
  clearUnsavedBuffer: (id: string) => void
  /** Bump for changes that affect document state but not a buffer (create / delete / import). */
  bumpDocumentState: () => void

  // Theme
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void

  // UI language (default follows the system locale, persisted on change; fallback is English)
  language: Locale
  setLanguage: (language: Locale) => void

  // New doc dialog
  newDocOpen: boolean
  setNewDocOpen: (open: boolean) => void

  // About dialog (Help > About)
  aboutOpen: boolean
  setAboutOpen: (open: boolean) => void

  // Whether there are unsaved changes (for the "dirty" flag and pre-close confirmation)
  dirty: boolean
  setDirty: (dirty: boolean) => void

  // Whether a save is in progress (status bar shows "Saving")
  saving: boolean
  setSaving: (saving: boolean) => void

  // Whether printing is being prepared (status bar shows "Printing")
  printing: boolean
  setPrinting: (printing: boolean) => void

  // Just saved (status bar briefly shows "✓ Saved", then auto-hides)
  justSaved: boolean
  setJustSaved: (justSaved: boolean) => void

  // Prompt when the on-disk file was modified by another program (null = no prompt)
  externalChange: { id: string; filePath: string } | null
  setExternalChange: (change: { id: string; filePath: string } | null) => void
  clearExternalChange: () => void

  // File details dialog: shows the current document's path / size / modified date etc. (null = closed)
  fileDetailsId: string | null
  setFileDetailsId: (id: string | null) => void

  // Export HTML dialog (R7)
  exportOpen: boolean
  setExportOpen: (open: boolean) => void

  // Whether the export cache holds a COMPLETE render of the CURRENT document.
  // The cache itself lives in a non-reactive singleton (lib/exportStore), so the readiness has
  // to be mirrored here to drive the dialog's button state (C20 补 ⑦ / E12). It flips to false
  // while a document switch or a parse is in flight — during that window the cache still holds
  // the PREVIOUS document's HTML, so exporting would silently write the wrong file.
  exportReady: boolean
  setExportReady: (v: boolean) => void

  // Whether an export write is in progress (hard lock: while exporting or with the dialog open,
  // closing the current file or workspace is forbidden, so even an accidental "Close Workspace"
  // shortcut (Cmd/Ctrl+W) won't lose the workspace).
  exporting: boolean
  setExporting: (v: boolean) => void

  // Cross-component file-action bridge . Set by the sidebar's "Rename" menu to
  // ask the editor to enter title-edit; consumed (and cleared) by EditorPane's effect.
  pendingFileAction: FileAction | null
  requestFileAction: (a: FileAction | null) => void
}

const initialSearch = {
  searchQuery: '',
  searchInclude: '',
  searchExclude: '',
  searchMatchCase: false,
  searchWholeWord: false,
  searchRegexp: false,
  searchReplaceText: '',
  searchReplaceOpen: false,
  searchDetailsOpen: false,
  searchFocusNonce: 0,
  searchScopeFocusNonce: 0,
  panelFocusNonce: 0,
}

export const useUIStore = create<UIState>((set, get) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  sidebarView: 'files',
  setSidebarView: (view) => set({ sidebarView: view }),

  showAllFolders: false,
  setShowAllFolders: (showAllFolders) => set({ showAllFolders }),
  toggleShowAllFolders: () => set((s) => ({ showAllFolders: !s.showAllFolders })),

  recentlyCreatedFolders: new Set<string>(),
  markFolderCreated: (path) =>
    set((s) => ({ recentlyCreatedFolders: new Set(s.recentlyCreatedFolders).add(path) })),
  clearCreatedFolder: (path) =>
    set((s) => {
      const next = new Set(s.recentlyCreatedFolders)
      next.delete(path)
      return { recentlyCreatedFolders: next }
    }),

  activeDocumentId: null,
  // Switching documents always returns to read-only mode. This protects files from accidental
  // edits: every file opens/switches into read-only, and the user must explicitly switch to edit
  // mode to modify it. New documents opt back into edit mode afterwards (Sidebar/NewDocumentDialog
  // call setEditable(true) right after setActiveDocumentId).
  setActiveDocumentId: (id) => set({ activeDocumentId: id, editable: false }),

  activeDocumentTitle: null,
  setActiveDocumentTitle: (title) => set({ activeDocumentTitle: title }),

  guardUnsavedSwitch: async () => {
    if (!get().dirty) return true
    if (!(await confirmDiscard(get().activeDocumentTitle ?? ''))) {
      focusEditorPane()
      return false
    }
    return true
  },

  selectDocument: async (id) => {
    const state = get()
    if (id === state.activeDocumentId) return true
    // Not dirty → nothing to ask. Kept synchronous (no `await`) so a clean switch still lands in
    // the same task: callers are click handlers that read `activeDocumentId` right after.
    if (!state.dirty) {
      state.setActiveDocumentId(id)
      return true
    }
    if (!(await get().guardUnsavedSwitch())) {
      // Nothing changes: no new active document, no pending match, edit mode untouched.
      return false
    }
    get().clearUnsavedBuffer(state.activeDocumentId ?? '')
    get().setActiveDocumentId(id)
    return true
  },

  openDocumentAt: async (id, start, end) => {
    const state = get()
    if (id !== state.activeDocumentId && state.dirty) {
      if (!(await get().guardUnsavedSwitch())) return false
      get().clearUnsavedBuffer(state.activeDocumentId ?? '')
    }
    set({ activeDocumentId: id, editable: false, pendingMatch: { id, start, end } })
    return true
  },

  activeFolder: null,
  setActiveFolder: (folder) => set({ activeFolder: folder }),

  editable: false,
  setEditable: (editable) => set({ editable }),
  toggleEditable: () => set((s) => ({ editable: !s.editable })),

  // While exporting or with the export dialog open, forbid closing the current file/workspace:
  // this is a hard guarantee covering all call paths (menu shortcuts, sidebar close button, etc.),
  // ensuring "exporting HTML never closes the current file or workspace".
  closeDocument: () => {
    if (get().exporting || get().exportOpen) return
    // A memory-only draft that was never saved to disk has no file and only a store entry.
    // Remove that orphan store entry on close so we don't leave a zombie draft
    const id = get().activeDocumentId
    if (id && get().isNewUnsaved) {
      void deleteUnsavedDraft(id)
    }
    // Closing a document DISCARDS its unsaved edits, so the global `dirty` flag has to go
    // with it. It used to survive the close: every "discard?" path only called
    // closeDocument()/closeWorkspace() (App close-file menu, editor close button, quit),
    // so after discarding once, the NEXT dirty check (switching documents in the sidebar,
    // dropping a file onto the window, quitting) prompted "unsaved changes" AGAIN for
    // edits the user had already chosen to throw away. Clearing it here covers every
    // caller at once instead of patching each confirm site.
    set((s) => ({
      activeDocumentId: null,
      activeDocumentTitle: null,
      editable: false,
      isNewUnsaved: false,
      dirty: false,
      unsavedBuffers: {},
      documentStateRevision: s.documentStateRevision + 1,
    }))
  },

  closeWorkspace: () => {
    if (get().exporting || get().exportOpen) return
    const id = get().activeDocumentId
    if (id && get().isNewUnsaved) {
      void deleteUnsavedDraft(id)
    }
    clearWorkspaceRoot()
    set((s) => ({
      activeDocumentId: null,
      activeDocumentTitle: null,
      activeFolder: null,
      editable: false,
      isNewUnsaved: false,
      dirty: false,
      pendingMatch: null,
      unsavedBuffers: {},
      documentStateRevision: s.documentStateRevision + 1,
      sidebarView: 'files',
      ...initialSearch,
    }))
  },

  viewMode: 'split',
  setViewMode: (mode) => set({ viewMode: mode }),

  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  searchInclude: '',
  setSearchInclude: (v) => set({ searchInclude: v }),
  searchExclude: '',
  setSearchExclude: (v) => set({ searchExclude: v }),
  searchMatchCase: false,
  setSearchMatchCase: (v) => set({ searchMatchCase: v }),
  searchWholeWord: false,
  setSearchWholeWord: (v) => set({ searchWholeWord: v }),
  searchRegexp: false,
  setSearchRegexp: (v) => set({ searchRegexp: v }),
  searchReplaceText: '',
  setSearchReplaceText: (v) => set({ searchReplaceText: v }),
  searchReplaceOpen: false,
  setSearchReplaceOpen: (v) => set({ searchReplaceOpen: v }),
  searchDetailsOpen: false,
  setSearchDetailsOpen: (v) => set({ searchDetailsOpen: v }),
  searchFocusNonce: 0,
  requestSearchFocus: () => set((s) => ({ searchFocusNonce: s.searchFocusNonce + 1 })),
  searchScopeFocusNonce: 0,
  requestScopeFocus: () => set((s) => ({ searchScopeFocusNonce: s.searchScopeFocusNonce + 1 })),
  panelFocusNonce: 0,
  requestPanelFocus: () => set((s) => ({ panelFocusNonce: s.panelFocusNonce + 1 })),

  pendingMatch: null,
  setPendingMatch: (m) => set({ pendingMatch: m }),

  unsavedBuffers: {},
  documentStateRevision: 0,
  reportUnsavedBuffer: (id, content) =>
    set((s) => {
      const previous = s.unsavedBuffers[id]
      const revision = (previous?.revision ?? 0) + 1
      return {
        unsavedBuffers: { ...s.unsavedBuffers, [id]: { content, revision } },
        documentStateRevision: s.documentStateRevision + 1,
      }
    }),
  clearUnsavedBuffer: (id) =>
    set((s) => {
      if (!id || !(id in s.unsavedBuffers)) return {}
      const next = { ...s.unsavedBuffers }
      delete next[id]
      return { unsavedBuffers: next, documentStateRevision: s.documentStateRevision + 1 }
    }),
  bumpDocumentState: () => set((s) => ({ documentStateRevision: s.documentStateRevision + 1 })),

  theme: 'light',
  setTheme: (theme) => set({ theme }),

  language: resolveInitialLanguage(),
  setLanguage: (language) => {
    setStoredLanguage(language)
    set({ language })
  },

  newDocOpen: false,
  setNewDocOpen: (open) => set({ newDocOpen: open }),

  aboutOpen: false,
  setAboutOpen: (open) => set({ aboutOpen: open }),

  dirty: false,
  setDirty: (dirty) => set({ dirty }),

  saving: false,
  setSaving: (saving) => set({ saving }),

  printing: false,
  setPrinting: (printing) => set({ printing }),

  justSaved: false,
  setJustSaved: (justSaved) => set({ justSaved }),

  externalChange: null,
  setExternalChange: (externalChange) => set({ externalChange }),
  clearExternalChange: () => set({ externalChange: null }),

  fileDetailsId: null,
  setFileDetailsId: (id) => set({ fileDetailsId: id }),

  exportOpen: false,
  setExportOpen: (open) => set({ exportOpen: open }),

  exportReady: false,
  setExportReady: (v) => set({ exportReady: v }),

  exporting: false,
  setExporting: (v) => set({ exporting: v }),

  pendingFileAction: null,
  requestFileAction: (a) => set({ pendingFileAction: a }),

  isNewUnsaved: false,
  setIsNewUnsaved: (v) => set({ isNewUnsaved: v }),
}))

// e2e test hook: expose the real UI store (dev only, tree-shaven from prod builds)
// so end-to-end tests can drive the same store instance the app uses.
// The `false` branch (production builds) is unreachable under unit tests because
// `import.meta.env.DEV` is inlined to `true` in the test environment; it is
// exercised by the production build instead, so we exclude it from branch coverage.
/* v8 ignore next 3 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __uiStore?: typeof useUIStore }).__uiStore = useUIStore
}
