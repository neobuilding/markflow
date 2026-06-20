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
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  activeDocumentId: null,
  setActiveDocumentId: (id) => set({ activeDocumentId: id }),

  viewMode: 'split',
  setViewMode: (mode) => set({ viewMode: mode }),

  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  theme: 'light',
  setTheme: (theme) => set({ theme }),

  newDocOpen: false,
  setNewDocOpen: (open) => set({ newDocOpen: open })
}))
