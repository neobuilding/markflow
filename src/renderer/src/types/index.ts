export interface Document {
  id: string
  title: string
  folderPath: string
  filePath: string
  content: string
  wordCount: number
  isArchived: boolean
  createdAt: number
  updatedAt: number
}

export interface SearchResult {
  id: string
  title: string
  folderPath: string
  snippet: string
  score: number
  updatedAt: number
}

export type ViewMode = 'edit' | 'preview' | 'split'
export type ThemeMode = 'light' | 'dark' | 'system'
