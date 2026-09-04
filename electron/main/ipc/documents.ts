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
  statSync,
  openSync,
  writeSync,
  closeSync,
  promises as fsPromises,
} from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { detect } from 'jschardet-ultra'
import iconv from 'iconv-lite'
import { MD_EXTS, stripMarkdownExt } from '../lib/markdown-ext'
import {
  addWatchedFolder,
  markOwnWrite,
  startFolderWatching,
  stopFolderWatching,
} from '../model/folderWatcher'
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

// True when the buffer is plain ASCII text: every byte <= 0x7f AND no NUL bytes.
// Such a buffer decodes identically under every encoding, so it is unambiguously
// UTF-8 and needs no detection at all. This is a plain byte scan — orders of
// magnitude cheaper than iconv.decode, which has to build a full JS string
// before it can be inspected.
//
// The NUL check is not optional. UTF-16/32 encode ASCII text as NUL-interleaved
// bytes (0x41 0x00 …), so EVERY byte passes a naive <= 0x7f test; letting those
// through classifies a BOM-less UTF-16 note as UTF-8 and hands the caller
// NUL-interleaved garbage. jschardet detects them correctly (UTF-16 / UTF-32),
// but only if it is given the chance.
function isPlainAsciiText(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b > 0x7f || b === 0x00) return false
  }
  return true
}

export function detectEncoding(buf: Buffer): { enc: string; confidence: number } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { enc: 'utf-8', confidence: 1 }
  if (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00)
    return { enc: 'utf-32le', confidence: 1 }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { enc: 'utf-16le', confidence: 1 }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { enc: 'utf-16be', confidence: 1 }
  const sample = buf.subarray(0, Math.min(buf.length, SAMPLE_LIMIT))
  // Fast path: ASCII-only input is UTF-8 by definition — skip the detector and
  // every decode below. (BOMs were handled above.) Large English notes hit this
  // and go from hundreds of milliseconds to a fraction of one.
  //
  // An EMPTY buffer deliberately falls through: it contains no bytes to judge,
  // so claiming confidence 1 would invent certainty the detector never gave.
  // Letting detect() run preserves the "no encoding -> utf-8, confidence 0"
  // fallback that callers rely on.
  if (sample.length > 0 && isPlainAsciiText(sample)) return { enc: 'utf-8', confidence: 1 }
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

  // Fast path — the single biggest cost in this function used to be right here.
  //
  // cjkSecondPass decodes the WHOLE sample once per candidate encoding (utf-8 +
  // gbk + big5 + shift_jis + euc-kr = 5 full decodes) and scans every character
  // for U+FFFD. With SAMPLE_LIMIT at 1MB a 146KB note costs ~274ms of
  // SYNCHRONOUS main-process CPU, and importing a folder of such notes freezes
  // the whole app: everything is on the same single thread.
  //
  // But the loop only ever replaces `best` when a candidate yields FEWER
  // replacement chars. Zero is already the floor — no candidate can beat it. So
  // when the primary encoding decodes cleanly, the other four decodes are pure
  // waste and can be skipped with identical results.
  const primaryRep = countReplacements(sample, primary)
  if (primaryRep === 0) {
    return { enc: primary, confidence: Math.max(primaryConf, 0.99) }
  }
  // Deliberately NOT truncated to a small window. Encoding is a property of the
  // whole file, and a note whose first kilobytes are English (byte-identical in
  // ASCII, UTF-8 and GBK) with Chinese only appearing further in looks perfectly
  // clean as UTF-8 inside a short window — which silently garbles the file.
  // Decoding the full sample here is affordable precisely because reaching this
  // line already requires the primary decode to have produced replacement chars;
  // the common, clean case exits via the fast path above instead.
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
// so we fetch it lazily via a getter to avoid the closure capturing null). `isDestroyed` is
// optional so test fakes (plain objects with just webContents.send) still satisfy the type.
let _getMainWindow:
  | (() => {
      webContents: { send: (channel: string, ...args: unknown[]) => void }
      isDestroyed?: () => boolean
    } | null)
  | null = null

// ─── Disk folder watching ────────────────────────────────────────────
// The store is the single source of truth; a recursive chokidar watcher over the
// folders the user opened (model/folderWatcher.ts) keeps it in sync with the
// filesystem. Files that appear or disappear at any depth are folded into the
// store and the renderer is told to refresh the list; a file modified by another
// program raises `app:file-changed`, which the renderer turns into the "reload?"
// prompt.

// Ask the renderer to refresh the sidebar list for the folder containing `dirPath`.
//
// Chokidar can fire a burst of add/unlink events in quick succession (e.g. when a tool
// touches several files at once, or when the OS reports a rename as unlink+add). Without
// coalescing, each event triggers a cross-process IPC message and a full list refetch on
// the renderer — which stacks onto whatever the user is doing (notably file switching)
// and surfaces as intermittent UI lag. We coalesce into a single broadcast per directory
// per ~300ms window, so a burst becomes one refresh.
//
// Coalescing is keyed PER DIRECTORY, not globally: the renderer scopes a refresh to the
// folder it is currently showing, so collapsing events from different directories into a
// single broadcast would silently drop the refresh for all but the last one — a file
// created in the active folder would stay invisible in the sidebar until some later
// event happened to touch that folder again.
const FOLDER_CHANGED_COALESCE_MS = 300
const folderChangedTimers = new Map<string, ReturnType<typeof setTimeout>>()

function notifyFolderChanged(dirPath: string): void {
  // Already queued for this directory: the pending broadcast will pick up everything
  // that changed in the meantime, because the renderer re-reads the whole folder list.
  if (folderChangedTimers.has(dirPath)) return
  const timer = setTimeout(() => {
    folderChangedTimers.delete(dirPath)
    // The coalesce window delays this send, and the quit flow keeps the main process
    // alive briefly after the window is destroyed — sending to a destroyed webContents
    // throws. Guard, same as the other delayed senders (menu.ts / lifecycle.ts).
    const win = _getMainWindow?.()
    if (win && !win.isDestroyed?.()) win.webContents.send('app:folder-changed', { dirPath })
  }, FOLDER_CHANGED_COALESCE_MS)
  folderChangedTimers.set(dirPath, timer)
}

// Test seam: deliver every coalesced folder-changed broadcast immediately and cancel its
// timer, so tests can assert `sentFolderChanged` synchronously without waiting for the
// real 300ms coalesce window. Production code never calls this.
export function __flushFolderChanged(): void {
  const dirs = [...folderChangedTimers.keys()]
  for (const timer of folderChangedTimers.values()) clearTimeout(timer)
  folderChangedTimers.clear()
  const win = _getMainWindow?.()
  if (!win || win.isDestroyed?.()) return
  for (const dir of dirs) win.webContents.send('app:folder-changed', { dirPath: dir })
}

// Drop every coalesced-but-not-yet-sent broadcast and its timer without sending anything.
// Called when the watcher is torn down (workspace closed): any folder event still pending
// was produced by the watcher being discarded, so telling the renderer to "refresh"
// because of it would be a spurious post-teardown refetch.
function cancelPendingFolderChanged(): void {
  for (const timer of folderChangedTimers.values()) clearTimeout(timer)
  folderChangedTimers.clear()
}

// Tell the renderer that `filePath` changed on disk (backs the "reload?" prompt).
// Guarded the same way as notifyFolderChanged: the reload-prompt IPC is pointless once
// the window is gone, and a destroyed webContents would throw on send.
function notifyFileChanged(id: string, filePath: string): void {
  const win = _getMainWindow?.()
  if (win && !win.isDestroyed?.()) win.webContents.send('app:file-changed', { id, filePath })
}

// Tell the renderer to re-read ONE document's record, because that document's identity
// changed behind its back: its file was deleted (record marked missing) or renamed
// outside the app. Deliberately NOT `app:folder-changed`: that one refreshes the whole
// sidebar list, while this refreshes only this document's detail — which is what the
// title bar reads. Widening the folder event to invalidate every detail was a measured
// source of lag while switching documents (see App.tsx), so the two stay separate.
function notifyDocumentRefresh(id: string): void {
  const win = _getMainWindow?.()
  if (win && !win.isDestroyed?.()) win.webContents.send('app:document-refresh', { id })
}

// A tracked document whose file had vanished and is back at the SAME path: it is no
// longer missing. The content is deliberately left alone — an external CONTENT change is
// `app:file-changed`'s job (it asks the user), not the watcher's to apply silently.
function reviveDocument(existing: Document): void {
  if (!existing.missing) return
  storeUpdate(existing.id, { missing: false })
  notifyDocumentRefresh(existing.id)
}

// Find the document an external rename should be folded back into.
//
// chokidar reports a rename as an UNPAIRED `unlink <old>` + `add <new>` — there is no
// rename event and nothing correlates the two — so the only way to recognise one is to
// look for a document we have just marked missing, sitting in the same directory, holding
// the same bytes. The content is the fingerprint, which makes this exact for a plain
// rename (what Explorer / Finder / `git mv` do). A rename that also rewrote the file is
// not matched and simply appears as a new document — predictable, and never destructive.
function findRenamedDocument(filePath: string, text: string): Document | null {
  const dir = dirname(filePath)
  // No need to skip `d.filePath === filePath`: syncAddedFile already returned above for
  // any document tracked under this exact path (that is the restore case).
  for (const d of storeList()) {
    if (!d.missing) continue
    if (dirname(d.filePath) !== dir) continue
    if (d.content !== text) continue
    return d
  }
  return null
}

// Read a Markdown file that just appeared on disk into the store.
// Files we already know about are left alone: our own saves and Save As already
// upserted them, and their watcher events must not create a second record for the
// same path (which would show up as a duplicate entry in the sidebar).
function syncAddedFile(filePath: string): void {
  const tracked = storeGetByPath(filePath)
  if (tracked) {
    reviveDocument(tracked)
    return
  }
  let text: string
  let encoding: string
  let confidence: number
  try {
    ;({ text, encoding, confidence } = readMarkdownText(filePath))
  } catch {
    // Unreadable or already gone: leave the store untouched rather than let the
    // watcher callback throw.
    return
  }
  const renamed = findRenamedDocument(filePath, text)
  if (renamed) {
    // The file was renamed outside the app. Re-point the SAME record instead of
    // creating a new one, so the document keeps its id: the open editor stays on it,
    // its unsaved draft survives, and the title bar just shows the new name.
    storeUpdate(renamed.id, {
      title: stripMarkdownExt(basename(filePath)),
      folderPath: dirname(filePath),
      filePath,
      content: text,
      wordCount: countWords(text),
      encoding,
      encodingConfidence: confidence,
      missing: false,
      updatedAt: Date.now(),
    })
    notifyDocumentRefresh(renamed.id)
    notifyFolderChanged(dirname(filePath))
    return
  }
  const now = Date.now()
  const doc = makeDocument({
    id: randomUUID(),
    title: stripMarkdownExt(basename(filePath)),
    folderPath: dirname(filePath),
    filePath,
    content: text,
    wordCount: countWords(text),
    encoding,
    encodingConfidence: confidence,
    createdAt: now,
    updatedAt: now,
    memoryOnly: false,
  })
  storeUpsert(doc)
  notifyFolderChanged(dirname(filePath))
}

export function registerDocumentHandlers(
  ipcMain: IpcMain,
  app: App,
  getMainWindow: () => unknown,
): void {
  _app = app
  _getMainWindow = getMainWindow as () => {
    webContents: { send: (channel: string, ...args: unknown[]) => void }
    isDestroyed?: () => boolean
  } | null

  // Recursive folder watching: keep the store in sync with the filesystem for every
  // folder the user opened. Handlers are installed here (rather than in
  // model/folderWatcher.ts) so that folderWatcher stays free of any dependency on the
  // document store — otherwise documents.ts and folderWatcher.ts would import each other.
  startFolderWatching({
    onFileAdded: (filePath) => syncAddedFile(filePath),
    onFileRemoved: (filePath) => {
      // A rename reaches chokidar as `unlink <old>` + `add <new>`, and the two are not
      // paired: either can be delivered long after the filesystem has moved on. Renaming
      // a.md -> b.md -> back to a.md therefore replays an `unlink` for a.md at a moment
      // when that path EXISTS again and is still the open document — deleting the record
      // then closed the file (and emptied the sidebar). Never trust the removal while
      // the file is still on disk; a genuinely deleted file is gone by now.
      if (existsSync(filePath)) return
      const existing = storeGetByPath(filePath)
      if (!existing) return
      // VS Code behaviour: a file deleted (or moved) outside the app stays OPEN, its
      // title struck through, so an accidental deletion can still be saved straight back
      // to disk. The record is therefore marked missing instead of dropped — it only
      // disappears when the user closes the document, or on restart (this store is
      // in-memory and rebuilt from disk). A rename looks the same at this point and is
      // repaired by syncAddedFile, which re-points this very record at the new path.
      storeUpdate(existing.id, { missing: true })
      notifyDocumentRefresh(existing.id)
      notifyFolderChanged(dirname(filePath))
    },
    onFileChanged: (filePath) => {
      const existing = storeGetByPath(filePath)
      if (!existing) return
      notifyFileChanged(existing.id, filePath)
    },
  })

  // List all documents (sorted by updated_at): read directly from the store, the single
  // source of truth (kept in sync with the filesystem by the folder watcher above).
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
      // Suppress the watcher events this write raises (some platforms report a
      // follow-up `change` right after `add`, which would otherwise pop the
      // "changed externally" prompt for a document the user just created).
      // Anchored *after* the write on purpose: the watcher only reports once the file
      // settles, so the window must start there — a slow write would otherwise outlive it.
      markOwnWrite(filePath)

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

      // Titles are stored WITHOUT the Markdown extension — that is how `import`
      // derives them and how the rename below re-appends the file's own extension.
      // The renderer sends the name as the title bar shows it (`notes.md`), so strip
      // the extension once here; otherwise a rename would build `notes.md.md`.
      const newTitle =
        updates.title === undefined ? existing.title : stripMarkdownExt(updates.title)
      const newContent = updates.content ?? existing.content
      const wordCount = countWords(newContent)

      // Write to file (suppress the "file changed" notification that this write would otherwise trigger)
      // Write back in the document's original metadata encoding to preserve byte-level fidelity (R5).
      // A memory-only draft (file_path === '') has no file yet; the first Save is always routed to
      // Save As, so this branch is defensive only. Skip the disk write to avoid writing to an empty path.
      if (existing.filePath) {
        writeFileSync(existing.filePath, iconv.encode(newContent, existing.encoding || 'utf-8'))
        // Suppress the "file changed" notification this write raises. Anchored after the
        // write rather than before it: the watcher reports once the file settles, so a
        // slow write would otherwise outlive the window and pop a bogus prompt.
        markOwnWrite(existing.filePath)
      }

      // Rename file if title changed
      let newFilePath = existing.filePath
      // Compare the NORMALIZED title, not the raw one. The renderer sends the
      // extension-free name, but a caller that still passes the display form
      // (`notes.md`) would otherwise differ from `existing.title` (`notes`) on
      // every save and walk into the rename branch for nothing — the `-N` probe
      // below only survives that because of its own `target !== existing.filePath`
      // check. `newTitle &&` keeps an empty title from renaming to a bare extension.
      if (newTitle && newTitle !== existing.title && existing.filePath) {
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
        // Writing the file back is what undoes an external deletion: the document is
        // no longer missing, so the strikethrough comes off.
        missing: false,
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
      // The document is being re-pointed at a brand-new file the user picked, so the
      // file name is the title — the caller's (possibly stale, possibly
      // extension-bearing) title would leave the two out of sync.
      const title = stripMarkdownExt(basename(newFilePath))
      const wordCount = countWords(content)
      const now = Date.now()

      mkdirSync(dirname(newFilePath), { recursive: true })
      // Save As: write back in the source document's original encoding (the copy inherits that encoding, R5).
      writeFileSync(newFilePath, iconv.encode(content, existing.encoding || 'utf-8'))
      // Suppress the "file changed" notification this write raises, anchored after the
      // write so that a slow write cannot outlive the window.
      markOwnWrite(newFilePath)

      const folderPath = dirname(newFilePath)
      return storeUpdate(id, {
        title,
        folderPath,
        filePath: newFilePath,
        content,
        wordCount,
        // The document now lives at the chosen path, so it is no longer missing.
        missing: false,
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

  // Register a folder the user opened so the watcher picks up files created or
  // deleted anywhere beneath it (at any depth, not just the active subfolder).
  ipcMain.handle('documents:set-open-folder', (_event, folderPath: string) => {
    addWatchedFolder(folderPath)
  })

  // The workspace was closed: stop watching and forget every opened folder.
  // Never rejects — the renderer fires this call and ignores the result, so a
  // rejection here would surface as an unhandled promise rejection.
  ipcMain.handle('documents:clear-open-folders', async () => {
    try {
      await stopFolderWatching()
    } catch {
      // The watcher is being discarded anyway; a failed close must not propagate.
    }
    // The watcher is gone: a folder-changed broadcast still pending came from it and
    // must not reach the renderer as a refresh for a workspace that is already closed.
    cancelPendingFolderChanged()
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
    const title = stripMarkdownExt(basename(filePath))
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
      const title = stripMarkdownExt(basename(filePath))
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
  //
  // ASYNC on purpose. This used to be openSync/readSync, which blocked the whole
  // main process — and it fires twice on every document switch (once from
  // useLocalDocument for the save baseline, once from StatusBar for the CRLF/LF
  // pill). On a healthy local SSD that is sub-millisecond and invisible, but on a
  // network drive, an antivirus-scanned path, or a sleeping disk the same call
  // can take tens of milliseconds — during which EVERY other IPC (including the
  // sidebar list and the document fetch) stalls. That is the "the whole app
  // freezes for a moment when I switch files" symptom, and it is intermittent
  // precisely because it depends on the storage path's current latency.
  ipcMain.handle('documents:eol', async (_event, filePath: string) => {
    let handle: FileHandle | undefined
    try {
      handle = await fsPromises.open(filePath, 'r')
      const buf = Buffer.alloc(65536)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      const sample = buf.subarray(0, bytesRead).toString('utf-8')
      return sample.includes('\r\n') ? '\r\n' : '\n'
    } catch {
      return '\n'
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
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
