import type { IpcMain } from 'electron'
import type { App } from 'electron'
import { getDb } from '../db/database'

let _app: App | null = null
import { join, dirname, basename } from 'path'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'

export interface DocumentRow {
  id: string
  title: string
  folder_path: string
  file_path: string
  content: string
  word_count: number
  is_starred: number
  is_archived: number
  created_at: number
  updated_at: number
}

export interface Document {
  id: string
  title: string
  folderPath: string
  filePath: string
  content: string
  wordCount: number
  isStarred: boolean
  isArchived: boolean
  createdAt: number
  updatedAt: number
}

function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    title: row.title,
    folderPath: row.folder_path,
    filePath: row.file_path,
    content: row.content,
    wordCount: row.word_count,
    isStarred: row.is_starred === 1,
    isArchived: row.is_archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function countWords(text: string): number {
  return text
    .replace(/[#*`~\[\]()>|]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0).length
}

function getDefaultDocsDir(): string {
  const docsDir = join(_app!.getPath('documents'), 'MarkFlow')
  mkdirSync(docsDir, { recursive: true })
  return docsDir
}

export function registerDocumentHandlers(ipcMain: IpcMain, app: App): void {
  _app = app
  // List all documents (sorted by updated_at)
  ipcMain.handle('documents:list', (_event, folderPath?: string) => {
    const db = getDb()
    let rows: DocumentRow[]
    if (folderPath !== undefined && folderPath !== '') {
      rows = db
        .prepare(
          'SELECT * FROM documents WHERE folder_path = ? AND is_archived = 0 ORDER BY updated_at DESC'
        )
        .all(folderPath) as DocumentRow[]
    } else {
      rows = db
        .prepare('SELECT * FROM documents WHERE is_archived = 0 ORDER BY updated_at DESC')
        .all() as DocumentRow[]
    }
    return rows.map(toDocument)
  })

  // Get single document
  ipcMain.handle('documents:get', (_event, id: string) => {
    const db = getDb()
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      | DocumentRow
      | undefined
    return row ? toDocument(row) : null
  })

  // Create new document
  ipcMain.handle(
    'documents:create',
    (_event, params: { title?: string; folderPath?: string; content?: string }) => {
      const db = getDb()
      const id = randomUUID()
      const now = Date.now()
      const title = params.title || 'Untitled'
      const folderPath = params.folderPath || ''
      const content = params.content || `# ${title}\n\n`
      const wordCount = countWords(content)

      const baseDir = folderPath
        ? join(getDefaultDocsDir(), folderPath)
        : getDefaultDocsDir()
      mkdirSync(baseDir, { recursive: true })

      // Create unique filename
      let fileName = `${title.replace(/[/\\:*?"<>|]/g, '-')}.md`
      let filePath = join(baseDir, fileName)
      let counter = 1
      while (existsSync(filePath)) {
        fileName = `${title.replace(/[/\\:*?"<>|]/g, '-')}-${counter}.md`
        filePath = join(baseDir, fileName)
        counter++
      }

      // Write file
      writeFileSync(filePath, content, 'utf-8')

      // Insert into DB
      db.prepare(`
        INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_starred, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      `).run(id, title, folderPath, filePath, content, wordCount, now, now)

      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow
      return toDocument(row)
    }
  )

  // Update document content
  ipcMain.handle(
    'documents:update',
    (_event, id: string, updates: Partial<{ title: string; content: string }>) => {
      const db = getDb()
      const now = Date.now()
      const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
        | DocumentRow
        | undefined
      if (!existing) return null

      const newTitle = updates.title ?? existing.title
      const newContent = updates.content ?? existing.content
      const wordCount = countWords(newContent)

      // Write to file
      writeFileSync(existing.file_path, newContent, 'utf-8')

      // Rename file if title changed
      let newFilePath = existing.file_path
      if (updates.title && updates.title !== existing.title) {
        const dir = dirname(existing.file_path)
        let newFileName = `${newTitle.replace(/[/\\:*?"<>|]/g, '-')}.md`
        newFilePath = join(dir, newFileName)
        let counter = 1
        while (existsSync(newFilePath) && newFilePath !== existing.file_path) {
          newFileName = `${newTitle.replace(/[/\\:*?"<>|]/g, '-')}-${counter}.md`
          newFilePath = join(dir, newFileName)
          counter++
        }
        if (newFilePath !== existing.file_path) {
          renameSync(existing.file_path, newFilePath)
        }
      }

      db.prepare(`
        UPDATE documents
        SET title = ?, content = ?, word_count = ?, file_path = ?, updated_at = ?
        WHERE id = ?
      `).run(newTitle, newContent, wordCount, newFilePath, now, id)

      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow
      return toDocument(row)
    }
  )

  // Delete document
  ipcMain.handle('documents:delete', (_event, id: string) => {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      | DocumentRow
      | undefined
    if (!existing) return false

    try {
      if (existsSync(existing.file_path)) {
        unlinkSync(existing.file_path)
      }
    } catch (e) {
      console.error('Failed to delete file:', e)
    }

    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    return true
  })

  // Toggle star
  ipcMain.handle('documents:toggle-star', (_event, id: string) => {
    const db = getDb()
    db.prepare(
      'UPDATE documents SET is_starred = CASE WHEN is_starred = 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?'
    ).run(Date.now(), id)
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow
    return toDocument(row)
  })

  // Import markdown file from disk
  ipcMain.handle('documents:import', (_event, filePath: string) => {
    const db = getDb()
    if (!existsSync(filePath)) return null

    const content = readFileSync(filePath, 'utf-8')
    const title = basename(filePath, '.md')
    const id = randomUUID()
    const now = Date.now()
    const wordCount = countWords(content)

    // Check if already exists
    const existing = db
      .prepare('SELECT * FROM documents WHERE file_path = ?')
      .get(filePath) as DocumentRow | undefined
    if (existing) return toDocument(existing)

    db.prepare(`
      INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_starred, is_archived, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, ?, 0, 0, ?, ?)
    `).run(id, title, filePath, content, wordCount, now, now)

    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow
    return toDocument(row)
  })

  // Batch import multiple markdown files
  // Returns array of imported documents (skips already-imported files, but includes them in result)
  ipcMain.handle('documents:import-many', (_event, filePaths: string[]) => {
    const db = getDb()
    const results: Document[] = []
    const now = Date.now()

    const insertStmt = db.prepare(`
      INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_starred, is_archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `)
    const selectByPath = db.prepare('SELECT * FROM documents WHERE file_path = ?')
    const selectById = db.prepare('SELECT * FROM documents WHERE id = ?')

    const insertMany = db.transaction((paths: string[]) => {
      for (const filePath of paths) {
        if (!existsSync(filePath)) continue
        let content: string
        try {
          content = readFileSync(filePath, 'utf-8')
        } catch {
          continue
        }
        const title = basename(filePath).replace(/\.(md|markdown|mdx|mdtxt|mdtext)$/i, '')
        const wordCount = countWords(content)

        const existing = selectByPath.get(filePath) as DocumentRow | undefined
        if (existing) {
          results.push(toDocument(existing))
          continue
        }

        const id = randomUUID()
        insertStmt.run(id, title, '', filePath, content, wordCount, now, now)
        const row = selectById.get(id) as DocumentRow
        results.push(toDocument(row))
      }
    })

    insertMany(filePaths)
    return results
  })

  // Get starred documents
  ipcMain.handle('documents:starred', () => {
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM documents WHERE is_starred = 1 AND is_archived = 0 ORDER BY updated_at DESC')
      .all() as DocumentRow[]
    return rows.map(toDocument)
  })
}
