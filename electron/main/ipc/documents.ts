import type { IpcMain } from 'electron'
import type { App } from 'electron'
import { getDb } from '../db/database'

let _app: App | null = null
import { join, dirname, basename } from 'path'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync, watch, statSync } from 'fs'
import type { FSWatcher } from 'fs'
import { randomUUID } from 'crypto'

export interface DocumentRow {
  id: string
  title: string
  folder_path: string
  file_path: string
  content: string
  word_count: number
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

// 获取主窗口的引用（registerDocumentHandlers 在 createWindow 之前调用，
// 因此通过 getter 延迟获取，避免闭包捕获到 null）。
let _getMainWindow: (() => { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null) | null = null

// ─── 磁盘文件改动监听 ────────────────────────────────────────────
// 按文档 id 维护一个 fs.FSWatcher。当被监听的文件在磁盘上被其它程序
// 修改时，主动通知渲染层，由它询问用户是否重新加载。
// 我们自己写入文件时会临时压制一段时间，避免误报“文件已改动”。
const fileWatchers = new Map<string, FSWatcher>()
const suppressUntil = new Map<string, number>()

function watchDocument(id: string): void {
  if (fileWatchers.has(id)) return
  let row: { file_path: string } | undefined
  try {
    row = getDb()
      .prepare('SELECT file_path FROM documents WHERE id = ?')
      .get(id) as { file_path: string } | undefined
  } catch {
    return
  }
  if (!row?.file_path || !existsSync(row.file_path)) return
  const filePath = row.file_path
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const watcher = watch(filePath, () => {
      const now = Date.now()
      if (now < (suppressUntil.get(filePath) ?? 0)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const win = _getMainWindow?.()
        if (win) win.webContents.send('app:file-changed', { id, filePath })
      }, 300)
    })
    fileWatchers.set(id, watcher)
  } catch {
    // ignore — file may be inaccessible
  }
}

function unwatchDocument(id: string): void {
  const w = fileWatchers.get(id)
  if (w) {
    try {
      w.close()
    } catch {
      // ignore
    }
    fileWatchers.delete(id)
  }
}

export function registerDocumentHandlers(ipcMain: IpcMain, app: App, getMainWindow: () => unknown): void {
  _app = app
  _getMainWindow = getMainWindow as () => { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null
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
        INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
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

      // Write to file（压制随后由本次写入触发的“文件已改动”通知）
      suppressUntil.set(existing.file_path, Date.now() + 2000)
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

  // Save As：将内容写入一个全新的文件路径，并把数据库记录指向该新文件
  // （folder_path / file_path / title 同步更新）。原文件保持不变。
  ipcMain.handle(
    'documents:save-as',
    (_event, id: string, newFilePath: string, updates: { title?: string; content?: string }) => {
      const db = getDb()
      const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
        | DocumentRow
        | undefined
      if (!existing) return null

      const content = updates.content ?? existing.content
      const title = updates.title ?? existing.title
      const wordCount = countWords(content)
      const now = Date.now()

      // 压制新文件的“文件已改动”通知（我们自己的写入）
      suppressUntil.set(newFilePath, Date.now() + 2000)
      mkdirSync(dirname(newFilePath), { recursive: true })
      writeFileSync(newFilePath, content, 'utf-8')

      const folderPath = dirname(newFilePath)
      db.prepare(`
        UPDATE documents
        SET title = ?, folder_path = ?, file_path = ?, content = ?, word_count = ?, updated_at = ?
        WHERE id = ?
      `).run(title, folderPath, newFilePath, content, wordCount, now, id)

      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow
      return toDocument(row)
    }
  )

  // Reload：从磁盘重新读取当前文件内容，写回数据库并返回最新文档。
  // 若文件已被删除，则返回 null。
  ipcMain.handle('documents:reload', (_event, id: string) => {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      | DocumentRow
      | undefined
    if (!existing) return null
    if (!existsSync(existing.file_path)) return null

    const content = readFileSync(existing.file_path, 'utf-8')
    const wordCount = countWords(content)
    const now = Date.now()
    db.prepare(`
      UPDATE documents SET content = ?, word_count = ?, updated_at = ? WHERE id = ?
    `).run(content, wordCount, now, id)

    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow
    return toDocument(row)
  })

  // 监听 / 取消监听某个文档对应文件的磁盘改动
  ipcMain.handle('documents:watch', (_event, id: string) => {
    watchDocument(id)
  })
  ipcMain.handle('documents:unwatch', (_event, id: string) => {
    unwatchDocument(id)
  })

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
    if (existing) {
      // 重新打开已导入的文件：以磁盘当前内容为准刷新数据库记录，
      // 避免加载到过期的缓存内容（例如上次会话未保存的改动、或外部程序已修改）。
      db.prepare(
        'UPDATE documents SET content = ?, word_count = ?, updated_at = ? WHERE id = ?'
      ).run(content, wordCount, now, existing.id)
      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(existing.id) as DocumentRow
      return toDocument(row)
    }

    db.prepare(`
      INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_archived, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, ?, 0, ?, ?)
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
      INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
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
          // 已导入过的文件：以磁盘当前内容刷新记录，确保加载的是最新内容
          db.prepare(
            'UPDATE documents SET content = ?, word_count = ?, updated_at = ? WHERE id = ?'
          ).run(content, wordCount, now, existing.id)
          const row = selectById.get(existing.id) as DocumentRow
          results.push(toDocument(row))
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

  // 文件详情：返回磁盘上的大小 / 创建时间 / 修改时间（用于详情对话框）
  ipcMain.handle('documents:stat', (_event, filePath: string) => {
    try {
      const st = statSync(filePath)
      return {
        exists: true,
        size: st.size,
        createdAt: st.birthtimeMs,
        updatedAt: st.mtimeMs
      }
    } catch {
      return { exists: false }
    }
  })
}
