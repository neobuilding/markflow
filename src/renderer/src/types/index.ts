export interface Document {
  id: string
  title: string
  folderPath: string
  filePath: string
  content: string
  wordCount: number
  encoding: string
  encodingConfidence: number
  createdAt: number
  updatedAt: number
  // True when the file behind this document no longer exists on disk (deleted or moved
  // outside the app). The document itself is kept open struck through so it can
  // still be saved back. Absent means the file is there.
  missing?: boolean
}

// The search wire types are shared with the Electron main process (they travel over IPC), so they
// are declared once in `shared/searchTypes.ts` and re-exported from this barrel. It is a type-only
// re-export: zero runtime cost, and it keeps every renderer import site (`../../types`) unchanged
// while making drift between the two processes impossible. Imported first and then re-exported
// because `SearchOptions` below also needs `SearchMode` as a LOCAL binding — `export type { ... }
// from` re-exports without binding the name, which left `SearchMode` unresolvable here.
import type { SearchMode, SearchMatch, SearchResult } from '../../../../shared/searchTypes'
export type { SearchMode, SearchMatch, SearchResult }

export type ViewMode = 'edit' | 'preview' | 'split'
export type ThemeMode = 'light' | 'dark' | 'system'

// Options for the search IPC: scope to a folder (and its sub-folders) and choose
// the search mode.
export interface SearchOptions {
  scopeFolder?: string | null
  mode?: SearchMode
}
