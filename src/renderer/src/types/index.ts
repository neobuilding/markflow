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

export interface SearchResult {
  id: string
  title: string
  folderPath: string
  // Absolute on-disk path of the matching document . Empty for
  // memory-only drafts that have no file yet.
  filePath: string
  snippet: string
  score: number
  updatedAt: number
}

export type ViewMode = 'edit' | 'preview' | 'split'
export type ThemeMode = 'light' | 'dark' | 'system'

// Sidebar search mode: 'filename' matches file names only; 'content' is the
// full-text search across title, body and folder path.
export type SearchMode = 'filename' | 'content'

// Options for the search IPC: scope to a folder (and its sub-folders) and choose
// the search mode.
export interface SearchOptions {
  scopeFolder?: string | null
  mode?: SearchMode
}
