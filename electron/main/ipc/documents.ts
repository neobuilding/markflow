import type { IpcMain } from 'electron'
import type { App } from 'electron'
import { getDb } from '../db/database'

let _app: App | null = null
import { join, dirname, basename } from 'path'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync, watch, statSync, openSync, readSync, closeSync } from 'fs'
import type { FSWatcher } from 'fs'
import { randomUUID } from 'crypto'
import { detect } from 'jschardet-ultra'
import iconv from 'iconv-lite'

export interface DocumentRow {
  id: string
  title: string
  folder_path: string
  file_path: string
  content: string
  word_count: number
  is_archived: number
  encoding: string
  encoding_confidence: number
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
  encoding: string
  encodingConfidence: number
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
    encoding: row.encoding ?? 'utf-8',
    encodingConfidence: row.encoding_confidence ?? 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ─── 编码检测 / 解码（R5 全编码自动识别） ──────────────────────────
// 编码检测策略（R5 全编码自动识别，2026-07-23 升级）：
// 主检测器用 jschardet-ultra（纯 JS，覆盖 100+ 编码含 CJK，API 兼容旧 jschardet）；
// 采样窗口由 64KB 扩大到 1MB；命中率低置信度时回退 utf-8；BOM 优先。
// 额外增加“CJK 二次判断”：用 iconv 对候选编码解码、统计 U+FFFD 替换符数量，
// 把“被误判为 UTF-8 的 GBK/Big5 等多字节编码”纠正回来，避免中文乱码。
const SAMPLE_LIMIT = 1 << 20 // 1MB：在准确率与超大文件开销间取平衡
const ENC_ALIAS: Record<string, string> = {
  UTF8: 'utf-8', UTF16: 'utf-16le', UTF16LE: 'utf-16le', UTF16BE: 'utf-16be',
  UTF32: 'utf-32le', UTF32LE: 'utf-32le', GB2312: 'gbk', GBK: 'gbk',
  GB18030: 'gbk', CP936: 'gbk', BIG5: 'big5',
  'WINDOWS-1252': 'win1252', 'ISO-8859-1': 'latin1',
}
export function normEnc(name: string): string {
  return ENC_ALIAS[name.toUpperCase()] ?? name.toLowerCase()
}

// 统计某编码解码后产生的 U+FFFD 替换符数量（越少说明该编码越匹配；∞ 表示无法解码）。
function countReplacements(sample: Buffer, encName: string): number {
  if (!iconv.encodingExists(encName)) return Infinity
  let decoded: string
  try {
    decoded = iconv.decode(sample, encName)
  } catch {
    return Infinity
  }
  let n = 0
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) === 0xfffd) n++
  }
  return n
}

// CJK 二次判断：比较 UTF-8 与常见 CJK 编码的解码干净程度，纠正 GBK/Big5 被误判为 UTF-8。
// 仅当 primary 落在 “UTF-8 / CJK 候选 / 低置信度” 范围内才调用（见 detectEncoding 的 inCjkScope 闸门），
// 以免把强置信的非 CJK 编码（如西里尔 windows-1251、ISO-8859-5）误覆盖为 GBK——
// GBK 解码任意字节通常 0 替换符，会比真实编码“更干净”从而抢占 best。
const CJK_CANDIDATES = ['utf-8', 'gbk', 'big5', 'shift_jis', 'euc-kr']
function cjkSecondPass(sample: Buffer, primary: string): { enc: string; confidence: number } {
  let best = primary
  let bestRep = countReplacements(sample, primary)
  for (const c of CJK_CANDIDATES) {
    if (c === primary) continue
    const rep = countReplacements(sample, c)
    if (rep < bestRep) {
      best = c
      bestRep = rep
    }
  }
  const confidence =
    best === 'utf-8'
      ? bestRep === 0 ? 0.99 : Math.max(0.1, 1 - bestRep / Math.max(1, sample.length))
      : bestRep === 0 ? 0.99 : Math.max(0.7, 1 - bestRep / Math.max(1, sample.length))
  return { enc: best, confidence }
}

export function detectEncoding(buf: Buffer): { enc: string; confidence: number } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { enc: 'utf-8', confidence: 1 }
  if (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) return { enc: 'utf-32le', confidence: 1 }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { enc: 'utf-16le', confidence: 1 }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { enc: 'utf-16be', confidence: 1 }
  const sample = buf.subarray(0, Math.min(buf.length, SAMPLE_LIMIT))
  const r = detect(sample)
  if (!r.encoding) return { enc: 'utf-8', confidence: 0 }
  const primary = normEnc(r.encoding)
  const primaryConf = r.confidence ?? 0
  // 二次判断闸门：仅 UTF-8 / CJK 候选 / 低置信度 才进入 CJK 二次判断；
  // 强置信的其它编码（西里尔、拉丁等）直接采信，避免被 CJK 候选误覆盖。
  const inCjkScope = primary === 'utf-8' || CJK_CANDIDATES.includes(primary) || primaryConf < 0.6
  if (!inCjkScope) {
    return primaryConf < 0.6 ? { enc: 'utf-8', confidence: primaryConf } : { enc: primary, confidence: primaryConf }
  }
  const fixed = cjkSecondPass(sample, primary)
  return fixed.confidence < 0.6 ? { enc: 'utf-8', confidence: fixed.confidence } : fixed
}
// 原始 Buffer 读取 → 检测编码 → 解码为字符串（带编码元数据）。
export function readMarkdownText(filePath: string): { text: string; encoding: string; confidence: number } {
  const buf = readFileSync(filePath) // 原始 Buffer，不指定编码
  const { enc, confidence } = detectEncoding(buf)
  return { text: iconv.decode(buf, enc), encoding: enc, confidence }
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
        INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_archived, encoding, encoding_confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 'utf-8', 1, ?, ?)
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
      // 按文档元数据中的原始编码写回，保持字节级保真（R5）。
      suppressUntil.set(existing.file_path, Date.now() + 2000)
      writeFileSync(existing.file_path, iconv.encode(newContent, existing.encoding || 'utf-8'))

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
      // 另存为：以源文档原始编码写回（副本沿用其编码，R5）。
      writeFileSync(newFilePath, iconv.encode(content, existing.encoding || 'utf-8'))

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

    const { text, encoding, confidence } = readMarkdownText(existing.file_path)
    const wordCount = countWords(text)
    const now = Date.now()
    db.prepare(`
      UPDATE documents SET content = ?, word_count = ?, encoding = ?, encoding_confidence = ?, updated_at = ? WHERE id = ?
    `).run(text, wordCount, encoding, confidence, now, id)

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

    const { text, encoding, confidence } = readMarkdownText(filePath)
    const title = basename(filePath, '.md')
    const id = randomUUID()
    const now = Date.now()
    const wordCount = countWords(text)

    // Check if already exists
    const existing = db
      .prepare('SELECT * FROM documents WHERE file_path = ?')
      .get(filePath) as DocumentRow | undefined
    if (existing) {
      // 重新打开已导入的文件：以磁盘当前内容为准刷新数据库记录，
      // 避免加载到过期的缓存内容（例如上次会话未保存的改动、或外部程序已修改）。
      db.prepare(
        'UPDATE documents SET content = ?, word_count = ?, encoding = ?, encoding_confidence = ?, updated_at = ? WHERE id = ?'
      ).run(text, wordCount, encoding, confidence, now, existing.id)
      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(existing.id) as DocumentRow
      return toDocument(row)
    }

    db.prepare(`
      INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_archived, encoding, encoding_confidence, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(id, title, filePath, text, wordCount, encoding, confidence, now, now)

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
      INSERT INTO documents (id, title, folder_path, file_path, content, word_count, is_archived, encoding, encoding_confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `)
    const selectByPath = db.prepare('SELECT * FROM documents WHERE file_path = ?')
    const selectById = db.prepare('SELECT * FROM documents WHERE id = ?')

    const insertMany = db.transaction((paths: string[]) => {
      for (const filePath of paths) {
        if (!existsSync(filePath)) continue
        let parsed: { text: string; encoding: string; confidence: number }
        try {
          parsed = readMarkdownText(filePath)
        } catch {
          continue
        }
        const content = parsed.text
        const title = basename(filePath).replace(/\.(md|markdown|mdx|mdtxt|mdtext)$/i, '')
        const wordCount = countWords(content)

        const existing = selectByPath.get(filePath) as DocumentRow | undefined
        if (existing) {
          // 已导入过的文件：以磁盘当前内容刷新记录，确保加载的是最新内容
          db.prepare(
            'UPDATE documents SET content = ?, word_count = ?, encoding = ?, encoding_confidence = ?, updated_at = ? WHERE id = ?'
          ).run(content, wordCount, parsed.encoding, parsed.confidence, now, existing.id)
          const row = selectById.get(existing.id) as DocumentRow
          results.push(toDocument(row))
          continue
        }

        const id = randomUUID()
        insertStmt.run(id, title, '', filePath, content, wordCount, parsed.encoding, parsed.confidence, now, now)
        const row = selectById.get(id) as DocumentRow
        results.push(toDocument(row))
      }
    })

    insertMany(filePaths)
    return results
  })

  // 读取文件“原始换行符”（仅读前 64KB，避免大文件开销）：保存时据此还原行尾。
  // 以磁盘文件本身为准，不受数据库内容（可能被旧版本改写过）影响。
  ipcMain.handle('documents:eol', (_event, filePath: string) => {
    try {
      if (!existsSync(filePath)) return '\n'
      const fd = openSync(filePath, 'r')
      const buf = Buffer.alloc(65536)
      const n = readSync(fd, buf, 0, buf.length, 0)
      closeSync(fd)
      const sample = buf.subarray(0, n).toString('utf-8')
      return sample.includes('\r\n') ? '\r\n' : '\n'
    } catch {
      return '\n'
    }
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

  // 手动切换编码：用用户选定编码重新解码磁盘文件，更新数据库内容与编码元数据。
  // 不写磁盘（文件字节不变），仅刷新内存中的解码结果，供编辑器重新渲染。
  ipcMain.handle('documents:set-encoding', (_event, id: string, enc: string) => {
    const db = getDb()
    const row = db.prepare('SELECT file_path FROM documents WHERE id = ?').get(id) as
      | { file_path: string }
      | undefined
    if (!row) return null
    if (!existsSync(row.file_path)) return null
    const buf = readFileSync(row.file_path)
    const norm = normEnc(enc)
    const text = iconv.decode(buf, norm)
    const now = Date.now()
    db.prepare(
      'UPDATE documents SET content = ?, encoding = ?, encoding_confidence = 1, updated_at = ? WHERE id = ?'
    ).run(text, norm, now, id)
    const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow
    return toDocument(updated)
  })
}
