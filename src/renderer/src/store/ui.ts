import { create } from 'zustand'
import type { ViewMode, ThemeMode } from '../types'

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

  // New doc dialog
  newDocOpen: boolean
  setNewDocOpen: (open: boolean) => void

  // 是否存在未保存的改动（用于“脏”标记与关闭前的确认）
  dirty: boolean
  setDirty: (dirty: boolean) => void

  // 是否正在保存（底部状态栏显示 “Saving…”）
  saving: boolean
  setSaving: (saving: boolean) => void

  // 刚刚保存过（底部状态栏瞬时显示 “✓ Saved”，延迟后自动消失）
  justSaved: boolean
  setJustSaved: (justSaved: boolean) => void

  // 磁盘文件被其它程序改动的提示（externalChange 为 null 表示无提示）
  externalChange: { id: string; filePath: string } | null
  setExternalChange: (change: { id: string; filePath: string } | null) => void
  clearExternalChange: () => void
}

export const useUIStore = create<UIState>((set) => ({
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

  closeDocument: () =>
    set({ activeDocumentId: null, editable: false }),

  closeWorkspace: () =>
    set({ activeDocumentId: null, activeFolder: null, editable: false }),

  viewMode: 'split',
  setViewMode: (mode) => set({ viewMode: mode }),

  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  theme: 'light',
  setTheme: (theme) => set({ theme }),

  newDocOpen: false,
  setNewDocOpen: (open) => set({ newDocOpen: open }),

  dirty: false,
  setDirty: (dirty) => set({ dirty }),

  saving: false,
  setSaving: (saving) => set({ saving }),

  justSaved: false,
  setJustSaved: (justSaved) => set({ justSaved }),

  externalChange: null,
  setExternalChange: (externalChange) => set({ externalChange }),
  clearExternalChange: () => set({ externalChange: null })
}))
