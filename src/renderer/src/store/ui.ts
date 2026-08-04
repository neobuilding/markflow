import { create } from 'zustand'
import type { ViewMode, ThemeMode } from '../types'
import { resolveInitialLanguage, setStoredLanguage, type Locale } from '../i18n'
import { queryClient, DOCS_KEY } from '../lib/queryClient'

// Remove a memory-only draft (never saved to disk) and refresh the document list so the
// sidebar no longer shows the orphan draft (PLAN §6.4).
function deleteUnsavedDraft(id: string) {
  return window.api.documents.delete(id).finally(() => {
    queryClient.invalidateQueries({ queryKey: DOCS_KEY })
  })
}

interface UIState {
  // Sidebar
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void

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

  // Whether a save is in progress (status bar shows "Saving…")
  saving: boolean
  setSaving: (saving: boolean) => void

  // Whether printing is being prepared (status bar shows "Printing…")
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
}

export const useUIStore = create<UIState>((set, get) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  activeDocumentId: null,
  setActiveDocumentId: (id) => set({ activeDocumentId: id }),

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
    // A memory-only draft that was never saved to disk has no file and only a DB row.
    // Remove that orphan DB row on close so we don't leave a zombie draft (PLAN §6.4).
    const id = get().activeDocumentId
    if (id && get().isNewUnsaved) {
      void deleteUnsavedDraft(id)
    }
    set({ activeDocumentId: null, editable: false, isNewUnsaved: false })
  },

  closeWorkspace: () => {
    if (get().exporting || get().exportOpen) return
    const id = get().activeDocumentId
    if (id && get().isNewUnsaved) {
      void deleteUnsavedDraft(id)
    }
    set({ activeDocumentId: null, activeFolder: null, editable: false, isNewUnsaved: false })
  },

  viewMode: 'split',
  setViewMode: (mode) => set({ viewMode: mode }),

  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

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

  isNewUnsaved: false,
  setIsNewUnsaved: (v) => set({ isNewUnsaved: v }),
}))
