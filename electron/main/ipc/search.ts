import type { IpcMain } from 'electron'
import { getDb } from '../db/database'

export interface SearchResult {
  id: string
  title: string
  folderPath: string
  snippet: string
  score: number
  updatedAt: number
}

export function registerSearchHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('search:query', (_event, query: string): SearchResult[] => {
    if (!query || query.trim().length === 0) return []

    const db = getDb()
    const safeQuery = query
      .trim()
      .replace(/['"*^()~]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"*`)
      .join(' OR ')

    try {
      const rows = db
        .prepare(`
          SELECT
            d.id,
            d.title,
            d.folder_path,
            d.updated_at,
            snippet(documents_fts, 2, '<mark>', '</mark>', '…', 30) AS snippet,
            rank AS score
          FROM documents_fts
          JOIN documents d ON d.id = documents_fts.id
          WHERE documents_fts MATCH ?
            AND d.is_archived = 0
          ORDER BY rank
          LIMIT 20
        `)
        .all(safeQuery) as Array<{
          id: string
          title: string
          folder_path: string
          updated_at: number
          snippet: string
          score: number
        }>

      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        folderPath: r.folder_path,
        snippet: r.snippet || '',
        score: r.score,
        updatedAt: r.updated_at
      }))
    } catch (e) {
      console.error('FTS search error:', e)
      // Fallback: LIKE search
      const likeQuery = `%${query.trim()}%`
      const rows = db
        .prepare(`
          SELECT id, title, folder_path, updated_at,
            SUBSTR(content, 1, 200) AS snippet
          FROM documents
          WHERE (title LIKE ? OR content LIKE ?) AND is_archived = 0
          ORDER BY updated_at DESC
          LIMIT 20
        `)
        .all(likeQuery, likeQuery) as Array<{
          id: string
          title: string
          folder_path: string
          updated_at: number
          snippet: string
        }>

      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        folderPath: r.folder_path,
        snippet: r.snippet || '',
        score: 0,
        updatedAt: r.updated_at
      }))
    }
  })
}
