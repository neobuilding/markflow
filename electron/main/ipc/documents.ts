import type { IpcMain } from 'electron'
import type { App } from 'electron'

let _app: App | null = null
import { join, dirname, basename, extname, isAbsolute } from 'node:path'
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  existsSync,
  watch,
  statSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
} from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { detect } from 'jschardet-ultra'
import iconv from 'iconv-lite'
import {
  type Document,
  listDocuments as storeList,
  getDocumentById as storeGet,
  upsertDocument as storeUpsert,
  updateDocument as storeUpdate,
  deleteDocument as storeDelete,
  getDocumentByFilePath as storeGetByPath,
} from '../model/documentStore'

export type { Document } from '../model/documentStore'

// Build a Document from the canonical fields used by the handlers.
function makeDocument(params: {
  id: string
  title: string
  folderPath: string
  filePath: string
  content: string
  wordCount: number
  encoding?: string
  encodingConfidence?: number
  createdAt: number
  updatedAt: number
  memoryOnly?: boolean
}): Document {
  return {
    id: params.id,
    title: params.title,
    folderPath: params.folderPath,
    filePath: params.filePath,
    content: params.content,
    wordCount: params.wordCount,
    encoding: params.encoding ?? 'utf-8',
    encodingConfidence: params.encodingConfidence ?? 1,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
    memoryOnly: params.memoryOnly,
  }
}

// ─── Encoding detection / decoding (R5 full encoding auto-detection) ─────────────
// Encoding detection strategy (R5 full encoding auto-detection, upgraded 2026-07-23):
// The primary detector uses jschardet-ultra (pure JS, covers 100+ encodings including CJK, API-compatible with the old jschardet);
// The sampling window is enlarged from 64KB to 1MB; low-confidence hits fall back to utf-8; BOM takes priority.
// Additionally a "CJK second pass" decodes candidate encodings with iconv and counts U+FFFD replacement characters,
// correcting multi-byte encodings (GBK/Big5 etc.) misdetected as UTF-8, to avoid garbled CJK text.
const SAMPLE_LIMIT = 1 << 20 // 1MB: balances accuracy against the cost of very large files
const ENC_ALIAS = new Map<string, string>([
  ['UTF8', 'utf-8'],
  ['UTF16', 'utf-16le'],
  ['UTF16LE', 'utf-16le'],
  ['UTF16BE', 'utf-16be'],
  ['UTF32', 'utf-32le'],
  ['UTF32LE', 'utf-32le'],
  ['GB2312', 'gbk'],
  ['GBK', 'gbk'],
  ['GB18030', 'gbk'],
  ['CP936', 'gbk'],
  ['BIG5', 'big5'],
  ['WINDOWS-1252', 'win1252'],
  ['ISO-8859-1', 'latin1'],
])
export function normEnc(name: string): string {
  return ENC_ALIAS.get(name.toUpperCase()) ?? name.toLowerCase()
}

// Supported Markdown extensions (kept in sync with the main-process MD_EXTS).
// Used to validate the extension passed to documents:create.
const MD_EXTS = new Set(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'])

// Count U+FFFD replacement chars produced when decoding with a given encoding (fewer = better match; Infinity = undecodable).
export function countReplacements(sample: Buffer, encName: string): number {
  if (!iconv.encodingExists(encName)) return Infinity
  // iconv-lite is lenient and never throws for a known encoding (it substitutes replacement chars),
  // so no try/catch is needed here.
  const decoded = iconv.decode(sample, encName)
  let n = 0
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) === 0xfffd) n++
  }
  return n
}

// CJK second pass: compare how cleanly UTF-8 vs common CJK encodings decode, correcting GBK/Big5 misdetected as UTF-8.
// Only called when primary is in the "UTF-8 / CJK candidate / low confidence" range (see the inCjkScope gate in detectEncoding);
// this avoids wrongly overriding high-confidence non-CJK encodings (e.g. Cyrillic windows-1251, ISO-8859-5) with GBK —
// GBK decoding arbitrary bytes usually yields 0 replacements, making it appear "cleaner" than the real encoding and seizing best.
const CJK_CANDIDATES = ['utf-8', 'gbk', 'big5', 'shift_jis', 'euc-kr']
export function cjkSecondPass(
  sample: Buffer,
  primary: string,
): { enc: string; confidence: number } {
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
      ? bestRep === 0
        ? 0.99
        : Math.max(0.1, 1 - bestRep / Math.max(1, sample.length))
      : bestRep === 0
        ? 0.99
        : Math.max(0.7, 1 - bestRep / Math.max(1, sample.length))
  return { enc: best, confidence }
}

export function detectEncoding(buf: Buffer): { enc: string; confidence: number } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { enc: 'utf-8', confidence: 1 }
  if (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00)
    return { enc: 'utf-32le', confidence: 1 }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { enc: 'utf-16le', confidence: 1 }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { enc: 'utf-16be', confidence: 1 }
  const sample = buf.subarray(0, Math.min(buf.length, SAMPLE_LIMIT))
  const r = detect(sample)
  if (!r.encoding) return { enc: 'utf-8', confidence: 0 }
  const primary = normEnc(r.encoding)
  // jschardet always returns a numeric confidence, so no `?? 0` fallback is needed here.
  const primaryConf = r.confidence
  // Second-pass gate: only UTF-8 / CJK candidates / low confidence enter the CJK second pass;
  // other high-confidence encodings (Cyrillic, Latin, etc.) are trusted directly to avoid being wrongly overridden by CJK candidates.
  const inCjkScope = primary === 'utf-8' || CJK_CANDIDATES.includes(primary) || primaryConf < 0.6
  if (!inCjkScope) {
    // Reaching here means primary is a non-CJK encoding detected with confidence >= 0.6 (otherwise
    // the `primaryConf < 0.6` term above would have routed it into the CJK second pass). Trust it directly.
    return { enc: primary, confidence: primaryConf }
  }
  // The CJK second pass already floors the returned confidence (utf-8: 0.1, CJK candidates: 0.7),
  // so its result is always a safe, decisive pick — return it directly.
  return cjkSecondPass(sample, primary)
}
// Raw Buffer read -> detect encoding -> decode to string (with encoding metadata).
export function readMarkdownText(filePath: string): {
  text: string
  encoding: string
  confidence: number
} {
  const buf = readFileSync(filePath) // raw Buffer, no encoding specified
  const { enc, confidence } = detectEncoding(buf)
  return { text: iconv.decode(buf, enc), encoding: enc, confidence }
}

export function countWords(text: string): number {
  return text
    .replace(/[\]#*`~[()>|]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0).length
}

function getDefaultDocsDir(): string {
  const docsDir = join(_app!.getPath('documents'), 'MarkFlow')
  mkdirSync(docsDir, { recursive: true })
  return docsDir
}

// Get a reference to the main window (registerDocumentHandlers is called before createWindow,
// so we fetch it lazily via a getter to avoid the closure capturing null).
let _getMainWindow:
  (() => { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null) | null =
  null

// ─── Disk file change watching ────────────────────────────────────────
// Maintain one fs.FSWatcher per document id. When the watched file is modified on disk by another
// program, proactively notify the renderer, which asks the user whether to reload.
// We temporarily suppress notifications while we write the file ourselves, to avoid false "file changed" alerts.
const fileWatchers = new Map<string, FSWatcher>()
const suppressUntil = new Map<string, number>()
// Baseline mtime of the "last confirmed unchanged" state of the watched file. Used when filename is null
// to determine whether the file itself changed (see the watchDocument callback).
const watchedMtime = new Map<string, number>()

// Directory watchers: one FSWatcher per directory, shared by all open documents in that directory
// (reference-counted). Used to notify the renderer when files are added/removed in the directory so
// the sidebar list can be refreshed. Keyed by the absolute directory path.
const dirWatchers = new Map<string, FSWatcher>()
const dirRefCount = new Map<string, number>()
const dirNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>()

function watchDirectory(dirPath: string): void {
  const existing = dirWatchers.get(dirPath)
  if (existing) {
    dirRefCount.set(dirPath, dirRefCount.get(dirPath)! + 1)
    return
  }
  try {
    const watcher = watch(dirPath, () => {
      // A directory change may be a sibling file write (e.g. exporting HTML) or an add/remove of
      // another document. We don't try to classify it here — we just debounce and tell the renderer
      // to refresh the list. Debouncing collapses burst events (e.g. an editor writing temp files).
      const t = dirNotifyTimers.get(dirPath)
      if (t) clearTimeout(t)
      dirNotifyTimers.set(
        dirPath,
        setTimeout(() => {
          dirNotifyTimers.delete(dirPath)
          const win = _getMainWindow?.()
          if (win) win.webContents.send('app:folder-changed', { dirPath })
        }, 400),
      )
    })
    dirWatchers.set(dirPath, watcher)
    dirRefCount.set(dirPath, 1)
  } catch {
    // ignore — directory may be inaccessible
  }
}

function unwatchDirectory(dirPath: string): void {
  const count = (dirRefCount.get(dirPath) ?? 0) - 1
  if (count > 0) {
    dirRefCount.set(dirPath, count)
    return
  }
  dirRefCount.delete(dirPath)
  const t = dirNotifyTimers.get(dirPath)
  if (t) clearTimeout(t)
  dirNotifyTimers.delete(dirPath)
  const w = dirWatchers.get(dirPath)
  if (w) {
    try {
      w.close()
    } catch {
      // ignore
    }
    dirWatchers.delete(dirPath)
  }
}

function watchDocument(id: string): void {
  if (fileWatchers.has(id)) return
  // Defensive: a store read failure (e.g. the store is unavailable) must not crash
  // watch setup. Skip watching rather than throw (regression guard for the
  // "watch swallows a store read failure" path).
  let doc: Document | null
  try {
    doc = storeGet(id)
  } catch {
    return
  }
  if (!doc?.filePath || typeof doc.filePath !== 'string') return
  const filePath = doc.filePath
  // Record the starting mtime as the "unchanged" baseline (for comparison when filename is null).
  // If the file is missing/unreadable, just skip watching instead of pre-checking with existsSync.
  try {
    watchedMtime.set(filePath, statSync(filePath).mtimeMs)
  } catch {
    watchedMtime.delete(filePath)
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const watcher = watch(filePath, (_event, filename) => {
      // Decide whether this fs.watch event is a genuine external change to the watched file
      // (vs. a sibling-file write in the same directory, e.g. exporting HTML). Logic extracted
      // into shouldIgnoreExternalChange so it can be unit-tested without real fs.watch events.
      if (shouldIgnoreExternalChange(filename, filePath)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => notifyExternalChange(id, filePath), 300)
    })
    fileWatchers.set(id, watcher)
  } catch {
    // ignore — file may be inaccessible
  }
  // Also watch the enclosing directory so add/remove of sibling files triggers a list refresh.
  try {
    watchDirectory(dirname(filePath))
  } catch {
    // ignore — directory may be inaccessible
  }
}

// Re-confirm the file's mtime changed (avoid a tiny race window) and notify the renderer that
// the watched file changed externally. Extracted from the fs.watch timer so it is unit-testable.
export function notifyExternalChange(id: string, filePath: string): void {
  try {
    watchedMtime.set(filePath, statSync(filePath).mtimeMs)
  } catch {
    /* ignore */
  }
  const win = _getMainWindow?.()
  if (win) win.webContents.send('app:file-changed', { id, filePath })
}

// Decide whether an fs.watch event should be IGNORED (i.e. is NOT a genuine external change
// to the watched file). Returns true when the event should be suppressed.
//  - A suppressed write (our own save, within the suppressUntil window) is ignored.
//  - When the changed filename is reported, only the watched file's own name counts; sibling
//    writes in the same directory (e.g. exporting HTML) are ignored.
//  - When the platform omits the filename, fall back to comparing the watched file's own mtime;
//    if it is unchanged the write was a sibling's, so ignore it.
export function shouldIgnoreExternalChange(
  filename: string | Buffer | null | undefined,
  filePath: string,
): boolean {
  const now = Date.now()
  if (now < (suppressUntil.get(filePath) ?? 0)) return true
  const name = typeof filename === 'string' ? filename : filename?.toString()
  if (name && name.length > 0) {
    return basename(name) !== basename(filePath)
  }
  // filename omitted: compare mtimes. If the watched file's mtime is unchanged it was a
  // sibling write; treat as ignore. An unreadable file is conservatively treated as a change.
  try {
    return statSync(filePath).mtimeMs === (watchedMtime.get(filePath) ?? -1)
  } catch {
    return false
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
  // Release the directory watch (decrement ref count; only closes when last document leaves).
  const doc = storeGet(id)
  if (doc?.filePath) {
    unwatchDirectory(dirname(doc.filePath))
    watchedMtime.delete(doc.filePath)
  }
}

export function registerDocumentHandlers(
  ipcMain: IpcMain,
  app: App,
  getMainWindow: () => unknown,
): void {
  _app = app
  _getMainWindow = getMainWindow as () => {
    webContents: { send: (channel: string, ...args: unknown[]) => void }
  } | null
  // List all documents (sorted by updated_at). Phase one: read directly from the store
  // (the single source of truth). In phase two this is backed by chokidar-driven store state.
  ipcMain.handle('documents:list', (_event, folderPath?: string) => {
    return storeList(folderPath)
  })

  // Get single document
  ipcMain.handle('documents:get', (_event, id: string) => {
    return storeGet(id)
  })

  // Create new document
  ipcMain.handle(
    'documents:create',
    (
      _event,
      params: {
        title?: string
        folderPath?: string
        content?: string
        ext?: string
        memoryOnly?: boolean
      },
    ) => {
      const id = randomUUID()
      const now = Date.now()
      const title = params.title || 'Untitled'
      const folderPath = params.folderPath || ''
      const content = params.content || `# ${title}\n\n`
      // Extension: validated against the known Markdown set; defaults to .md.
      const ext =
        params.ext && MD_EXTS.has(params.ext.toLowerCase()) ? params.ext.toLowerCase() : '.md'
      const wordCount = countWords(content)

      // Memory-only mode: a brand-new in-app document must NOT touch the filesystem
      // until the user explicitly saves it. We insert a draft record with an empty
      // file_path and skip both the disk write and the file watcher. The first Save
      // (Save As) later writes the file to the user-chosen path and backfills file_path.
      if (params.memoryOnly) {
        const doc = makeDocument({
          id,
          title,
          folderPath,
          filePath: '',
          content,
          wordCount,
          createdAt: now,
          updatedAt: now,
          memoryOnly: true,
        })
        return storeUpsert(doc)
      }

      // Plan §6.#13/#19: when an absolute folder path is supplied (e.g. the
      // renderer's activeFolder), write directly there (VS Code "save into the
      // opened folder" semantics). A relative sub-folder name is still joined onto
      // the default docs dir to preserve the legacy behavior.
      const baseDir = folderPath
        ? isAbsolute(folderPath)
          ? folderPath
          : join(getDefaultDocsDir(), folderPath)
        : getDefaultDocsDir()
      mkdirSync(baseDir, { recursive: true })

      // Create a unique filename atomically: open with O_EXCL ('wx') and retry with an
      // incrementing suffix until we win a free name, avoiding the existsSync/writeFileSync TOCTOU.
      const safeTitle = title.replace(/[/\\:*?"<>|]/g, '-')
      let fd: number
      let filePath: string
      let counter = 0
      while (true) {
        const candidate = counter === 0 ? `${safeTitle}${ext}` : `${safeTitle}-${counter}${ext}`
        filePath = join(baseDir, candidate)
        try {
          fd = openSync(filePath, 'wx')
          break
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
            counter++
            continue
          }
          throw e
        }
      }
      try {
        writeSync(fd, content, undefined, 'utf-8')
      } finally {
        closeSync(fd)
      }

      const doc = makeDocument({
        id,
        title,
        folderPath,
        filePath,
        content,
        wordCount,
        createdAt: now,
        updatedAt: now,
        memoryOnly: false,
      })
      return storeUpsert(doc)
    },
  )

  // Update document content
  ipcMain.handle(
    'documents:update',
    (_event, id: string, updates: Partial<{ title: string; content: string }>) => {
      const now = Date.now()
      const existing = storeGet(id)
      if (!existing) return null

      const newTitle = updates.title ?? existing.title
      const newContent = updates.content ?? existing.content
      const wordCount = countWords(newContent)

      // Write to file (suppress the "file changed" notification that this write would otherwise trigger)
      // Write back in the document's original metadata encoding to preserve byte-level fidelity (R5).
      // A memory-only draft (file_path === '') has no file yet; the first Save is always routed to
      // Save As, so this branch is defensive only. Skip the disk write to avoid writing to an empty path.
      if (existing.filePath) {
        suppressUntil.set(existing.filePath, Date.now() + 2000)
        writeFileSync(existing.filePath, iconv.encode(newContent, existing.encoding || 'utf-8'))
      }

      // Rename file if title changed
      let newFilePath = existing.filePath
      if (updates.title && updates.title !== existing.title && existing.filePath) {
        const dir = dirname(existing.filePath)
        const safeTitle = newTitle.replace(/[/\\:*?"<>|]/g, '-')
        const ext = extname(existing.filePath).toLowerCase() || '.md'
        // Pick a free target name: the title-based name, or `<title>-N<ext>` if already taken by
        // a *different* file. (renameSync replaces the target atomically on both Windows and POSIX,
        // so we probe existence explicitly to avoid clobbering an unrelated file.)
        let target = join(dir, `${safeTitle}${ext}`)
        let counter = 0
        while (target !== existing.filePath && existsSync(target)) {
          counter++
          target = join(dir, `${safeTitle}-${counter}${ext}`)
        }
        if (target !== existing.filePath) {
          renameSync(existing.filePath, target)
        }
        newFilePath = target
      }

      return storeUpdate(id, {
        title: newTitle,
        content: newContent,
        wordCount,
        filePath: newFilePath,
        updatedAt: now,
      })
    },
  )

  // Save As: write the content to a brand-new file path and point the record at that new file
  // (folder_path / file_path / title are updated in sync). The original file is left untouched.
  ipcMain.handle(
    'documents:save-as',
    (_event, id: string, newFilePath: string, updates: { title?: string; content?: string }) => {
      const existing = storeGet(id)
      if (!existing) return null

      const content = updates.content ?? existing.content
      const title = updates.title ?? existing.title
      const wordCount = countWords(content)
      const now = Date.now()

      // Suppress the new file's "file changed" notification (our own write)
      suppressUntil.set(newFilePath, Date.now() + 2000)
      mkdirSync(dirname(newFilePath), { recursive: true })
      // Save As: write back in the source document's original encoding (the copy inherits that encoding, R5).
      writeFileSync(newFilePath, iconv.encode(content, existing.encoding || 'utf-8'))

      const folderPath = dirname(newFilePath)
      return storeUpdate(id, {
        title,
        folderPath,
        filePath: newFilePath,
        content,
        wordCount,
        updatedAt: now,
      })
    },
  )

  // Reload: re-read the current file from disk, write back to the store, and return the latest document.
  // Returns null if the file has been deleted.
  ipcMain.handle('documents:reload', (_event, id: string) => {
    const existing = storeGet(id)
    if (!existing) return null

    let text: string
    let encoding: string
    let confidence: number
    try {
      ;({ text, encoding, confidence } = readMarkdownText(existing.filePath))
    } catch {
      return null
    }
    const wordCount = countWords(text)
    const now = Date.now()
    return storeUpdate(id, {
      content: text,
      wordCount,
      encoding,
      encodingConfidence: confidence,
      updatedAt: now,
    })
  })

  // Watch / unwatch disk changes for the file backing a document
  ipcMain.handle('documents:watch', (_event, id: string) => {
    watchDocument(id)
  })
  ipcMain.handle('documents:unwatch', (_event, id: string) => {
    unwatchDocument(id)
  })

  // Delete document
  ipcMain.handle('documents:delete', (_event, id: string) => {
    const existing = storeGet(id)
    if (!existing) return false

    try {
      // A memory-only draft has no file on disk (file_path === ''); skip the unlink so we
      // neither error nor leave a stray log line. Deleting such a draft just removes the store entry.
      if (existing.filePath) {
        unlinkSync(existing.filePath)
      }
    } catch (e) {
      // A missing file is not a failure here (already removed externally); only log real errors.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to delete file:', e)
      }
    }

    return storeDelete(id)
  })

  // Import markdown file from disk
  ipcMain.handle('documents:import', (_event, filePath: string) => {
    let text: string
    let encoding: string
    let confidence: number
    try {
      ;({ text, encoding, confidence } = readMarkdownText(filePath))
    } catch {
      return null
    }
    const title = basename(filePath).replace(/\.(md|markdown|mdx|mdtxt|mdtext)$/i, '')
    const now = Date.now()
    const wordCount = countWords(text)

    // Check if already imported (by file path)
    const existing = storeGetByPath(filePath)
    if (existing) {
      // Re-open an already-imported file: refresh the record from the current on-disk content,
      // avoiding stale cached content (e.g. unsaved changes from a previous session, or external edits).
      return storeUpdate(existing.id, {
        content: text,
        wordCount,
        encoding,
        encodingConfidence: confidence,
        updatedAt: now,
      })
    }

    const doc = makeDocument({
      id: randomUUID(),
      title,
      folderPath: '',
      filePath,
      content: text,
      wordCount,
      encoding,
      encodingConfidence: confidence,
      createdAt: now,
      updatedAt: now,
      memoryOnly: false,
    })
    return storeUpsert(doc)
  })

  // Batch import multiple markdown files
  // Returns array of imported documents (skips already-imported files, but includes them in result)
  ipcMain.handle('documents:import-many', (_event, filePaths: string[]) => {
    const results: Document[] = []
    const now = Date.now()

    for (const filePath of filePaths) {
      let parsed: { text: string; encoding: string; confidence: number }
      try {
        parsed = readMarkdownText(filePath)
      } catch {
        continue
      }
      const content = parsed.text
      const title = basename(filePath).replace(/\.(md|markdown|mdx|mdtxt|mdtext)$/i, '')
      const wordCount = countWords(content)

      const existing = storeGetByPath(filePath)
      if (existing) {
        // Already-imported file: refresh the record from the current on-disk content to ensure the latest is loaded
        results.push(
          storeUpdate(existing.id, {
            content,
            wordCount,
            encoding: parsed.encoding,
            encodingConfidence: parsed.confidence,
            updatedAt: now,
          }) as Document,
        )
        continue
      }

      const doc = makeDocument({
        id: randomUUID(),
        title,
        folderPath: '',
        filePath,
        content,
        wordCount,
        encoding: parsed.encoding,
        encodingConfidence: parsed.confidence,
        createdAt: now,
        updatedAt: now,
        memoryOnly: false,
      })
      results.push(storeUpsert(doc))
    }
    return results
  })

  // Read the file's original line endings (only the first 64KB, to avoid cost on large files): restored on save.
  // Trust the on-disk file itself, not the stored content (which an older version may have rewritten).
  // Avoid existsSync/openSync TOCTOU: try opening directly and treat any failure as "use default \n".
  ipcMain.handle('documents:eol', (_event, filePath: string) => {
    let fd: number | undefined
    try {
      fd = openSync(filePath, 'r')
      const buf = Buffer.alloc(65536)
      const n = readSync(fd, buf, 0, buf.length, 0)
      const sample = buf.subarray(0, n).toString('utf-8')
      return sample.includes('\r\n') ? '\r\n' : '\n'
    } catch {
      return '\n'
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
      }
    }
  })

  // File details: return the on-disk size / creation time / modification time (for the details dialog)
  ipcMain.handle('documents:stat', (_event, filePath: string) => {
    try {
      const st = statSync(filePath)
      return {
        exists: true,
        size: st.size,
        createdAt: st.birthtimeMs,
        updatedAt: st.mtimeMs,
      }
    } catch {
      return { exists: false }
    }
  })

  // Manual encoding switch: re-decode the on-disk file with the user-selected encoding and update store content + encoding metadata.
  // Does not write to disk (file bytes unchanged); only refreshes the in-memory decode result for the editor to re-render.
  ipcMain.handle('documents:set-encoding', (_event, id: string, enc: string) => {
    const existing = storeGet(id)
    if (!existing) return null
    let buf: Buffer
    try {
      buf = readFileSync(existing.filePath)
    } catch {
      return null
    }
    const norm = normEnc(enc)
    const text = iconv.decode(buf, norm)
    const now = Date.now()
    return storeUpdate(id, {
      content: text,
      encoding: norm,
      encodingConfidence: 1,
      updatedAt: now,
    })
  })
}
