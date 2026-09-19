import { create } from 'zustand'
import type { ViewMode, ThemeMode, SearchMode } from '../types'
import { resolveInitialLanguage, setStoredLanguage, type Locale } from '../i18n/storage'
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

// Tell the main process to drop its recursive watcher over the opened folders: with no
// folder open there is nothing to keep in sync, and a stale watcher would keep firing
// events for a directory the user is no longer browsing (see model/folderWatcher.ts).
// Best-effort and fire-and-forget closing the workspace must never be blocked by it,
// so both a synchronous throw (preload bridge unavailable) and a rejected promise are
// swallowed rather than escaping into the state transition.
function clearOpenFolders() {
  try {
    void Promise.resolve(window.api.documents.clearOpenFolders()).catch(() => {})
  } catch {
    // Nothing to tear down; the watcher is discarded when the app quits anyway.
  }
}

interface UIState {
  // Sidebar
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void

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
  setActiveDocumentId: (id: string | null) => void

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

  // Search
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  // Sidebar search mode: 'filename' matches file names only; 'content' is full-text.
  searchMode: SearchMode
  setSearchMode: (mode: SearchMode) => void

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

export const useUIStore = create<UIState>((set, get) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

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
    set({ activeDocumentId: null, editable: false, isNewUnsaved: false, dirty: false })
  },

  closeWorkspace: () => {
    if (get().exporting || get().exportOpen) return
    const id = get().activeDocumentId
    if (id && get().isNewUnsaved) {
      void deleteUnsavedDraft(id)
    }
    clearOpenFolders()
    set({
      activeDocumentId: null,
      activeFolder: null,
      editable: false,
      isNewUnsaved: false,
      dirty: false,
    })
  },

  viewMode: 'split',
  setViewMode: (mode) => set({ viewMode: mode }),

  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  searchMode: 'content',
  setSearchMode: (mode) => set({ searchMode: mode }),

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
