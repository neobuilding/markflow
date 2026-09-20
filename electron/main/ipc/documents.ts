import type { App, IpcMain } from 'electron'
import { shell } from 'electron'
import { join, dirname, basename, extname, isAbsolute, resolve, sep } from 'node:path'
import { promises as fsPromises } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { detect } from 'jschardet-ultra'
import iconv from 'iconv-lite'
import { MD_EXTS, stripMarkdownExt } from '../lib/markdown-ext'
// Every filesystem access goes through this port (see lib/disk-io.ts): the handlers
// below stay pure orchestration and can be driven by an in-memory fake in tests.
import { nodeDiskIO, type DirEntry, type DiskIO, type ReadHandle } from '../lib/disk-io'
import {
  addWatchedFolder,
  markOwnWrite,
  startFolderWatching,
  stopFolderWatching,
  pauseFolderWatching,
  resumeFolderWatching,
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
import { resolveAppdocPath } from './appdoc'
import { imageSize } from 'image-size'
// Case-sensitivity rule (pure) and its main-process edge detection. See
// docs/adr/0014-*.md: the rule lives in shared/fileUtils.ts and takes the detected
// flag as an argument so no platform check is baked into the rule itself.
import { arePathsSame } from '../../../shared/fileUtils'
import { isFileSystemCaseSensitive } from '../lib/disk-io'

// The active platform seam, chosen at handler-registration time (see registerDocumentHandlers).
// Module-local so every handler reads the single value the test (or the app) injected, instead of
// reaching into `process.platform` itself. Defaults to the real OS detector.
let activeIsFileSystemCaseSensitive: () => boolean = isFileSystemCaseSensitive

let _app: App | null = null

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
// this avoids wrongly overriding high-confidence non-CJK encodings (e.g. Cyrillic windows-1251, ISO-8859-5) with GBK
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
// UTF-8 and needs no detection at all. This is a plain byte scan orders of
// magnitude cheaper than iconv.decode, which has to build a full JS string
// before it can be inspected.
//
// The NUL check is not optional. UTF-16/32 encode ASCII text as NUL-interleaved
// bytes (0x41 0x00 ), so EVERY byte passes a naive <= 0x7f test; letting those
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
  // Fast path: ASCII-only input is UTF-8 by definition skip the detector and
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

  // Fast path the single biggest cost in this function used to be right here
  //
  // cjkSecondPass decodes the WHOLE sample once per candidate encoding (utf-8 +
  // gbk + big5 + shift_jis + euc-kr = 5 full decodes) and scans every character
  // for U+FFFD. With SAMPLE_LIMIT at 1MB a 146KB note costs ~274ms of
  // SYNCHRONOUS main-process CPU, and importing a folder of such notes freezes
  // the whole app: everything is on the same single thread.
  //
  // But the loop only ever replaces `best` when a candidate yields FEWER
  // replacement chars. Zero is already the floor no candidate can beat it. So
  // when the primary encoding decodes cleanly, the other four decodes are pure
  // waste and can be skipped with identical results.
  const primaryRep = countReplacements(sample, primary)
  if (primaryRep === 0) {
    return { enc: primary, confidence: Math.max(primaryConf, 0.99) }
  }
  // Deliberately NOT truncated to a small window. Encoding is a property of the
  // whole file, and a note whose first kilobytes are English (byte-identical in
  // ASCII, UTF-8 and GBK) with Chinese only appearing further in looks perfectly
  // clean as UTF-8 inside a short window which silently garbles the file
  // Decoding the full sample here is affordable precisely because reaching this
  // line already requires the primary decode to have produced replacement chars;
  // the common, clean case exits via the fast path above instead.
  // The CJK second pass already floors the returned confidence (utf-8: 0.1, CJK candidates: 0.7),
  // so its result is always a safe, decisive pick return it directly
  return cjkSecondPass(sample, primary)
}
// Raw Buffer read -> detect encoding -> decode to string (with encoding metadata).
export function readMarkdownText(
  filePath: string,
  io: DiskIO = nodeDiskIO,
): {
  text: string
  encoding: string
  confidence: number
} {
  const buf = io.readFile(filePath) // raw Buffer, no encoding specified
  const { enc, confidence } = detectEncoding(buf)
  return { text: iconv.decode(buf, enc), encoding: enc, confidence }
}

export function countWords(text: string): number {
  return text
    .replace(/[\]#*`~[()>|]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0).length
}

function getDefaultDocsDir(io: DiskIO = nodeDiskIO): string {
  const docsDir = join(_app!.getPath('documents'), 'MarkFlow')
  io.mkdir(docsDir, { recursive: true })
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
function syncAddedFile(filePath: string, io: DiskIO = nodeDiskIO): void {
  const tracked = storeGetByPath(filePath)
  if (tracked) {
    reviveDocument(tracked)
    return
  }
  let text: string
  let encoding: string
  let confidence: number
  try {
    ;({ text, encoding, confidence } = readMarkdownText(filePath, io))
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

// A FOLDER rename moves every file under it to a different directory, so chokidar
// reports each as an unpaired `unlink <old>` + `add <new>` whose directories differ —
// findRenamedDocument (which only folds same-directory renames) can never match them.
// Left to the watcher alone, every tracked file under the folder would end up as a
// stale "missing" record beside a fresh duplicate of itself in the sidebar. Re-point
// every record under the old prefix onto the new one right after the directory move,
// so the watcher events that follow find nothing left to do: `add <new>` hits
// storeGetByPath and revives (a no-op), and `unlink <old>` no longer has a record to
// mark missing. Titles stay untouched — a folder rename never changes a file's name.
function rePointFolderRecords(oldPath: string, newPath: string): void {
  // Trailing separators are normalised away, and the separator-terminated prefix keeps
  // a rename of `/examples` from matching a sibling `/examples2`.
  // The prefix match must be separator-insensitive: the renderer builds tree paths with
  // forward slashes (buildFileTree joins with '/'), so it calls rename-folder with
  // forward-slash paths even on Windows, where stored document paths use backslashes.
  // A mismatch here makes the prefix check fail, the old records stay behind, and the
  // sidebar shows the old folder beside a duplicate of the new one.
  const toPlatform = (p: string) => p.replace(/[\\/]+$/, '').replace(/\//g, sep)
  const oldNorm = toPlatform(oldPath)
  const newNorm = toPlatform(newPath)
  const prefix = oldNorm + sep
  for (const d of storeList()) {
    if (!d.filePath.replace(/\//g, sep).startsWith(prefix)) continue
    // Preserve the document's own separator style when rebuilding the new path: a doc
    // imported under a path with a different separator than `newNorm` keeps that style.
    const docSep = d.filePath.includes('\\') ? '\\' : '/'
    const filePath = (newNorm + d.filePath.slice(oldNorm.length)).replace(/[\\/]/g, docSep)
    storeUpdate(d.id, { folderPath: dirname(filePath), filePath, missing: false })
    notifyDocumentRefresh(d.id)
  }
  notifyFolderChanged(newNorm)
}

// A FILE rename moves a single document to a new name (same directory). Unlike a folder
// rename it has no nested children to walk, but it still has to re-point the one tracked
// record whose filePath matches — otherwise the watcher's unlink<old> + add<new> would
// surface as a stale "missing" record beside a fresh duplicate. Titles are rebuilt from
// the new base name (the sidebar shows `doc.title`, not the raw path), so the rename is
// reflected in the tree immediately. Separator-insensitive, like rePointFolderRecords.
function rePointFileRecord(oldPath: string, newPath: string): void {
  const toPlatform = (p: string) => p.replace(/[\\/]+$/, '').replace(/\//g, sep)
  const oldNorm = toPlatform(oldPath)
  const newNorm = toPlatform(newPath)
  for (const d of storeList()) {
    if (d.filePath.replace(/\//g, sep) !== oldNorm) continue
    const filePath = newNorm.replace(/[\\/]/g, d.filePath.includes('\\') ? '\\' : '/')
    storeUpdate(d.id, {
      folderPath: dirname(filePath),
      filePath,
      title: stripMarkdownExt(basename(filePath)),
      missing: false,
    })
    notifyDocumentRefresh(d.id)
  }
  notifyFolderChanged(dirname(newNorm))
}

// Remove every tracked document whose file lives inside `folderPath`. Driven by an
// explicit folder delete (documents:delete-folder): the recursive watcher is paused
// during the trash move, so it never fires the per-file onFileRemoved events for the
// documents inside, and resumeFolderWatching() does not replay removals. Without this
// the sidebar tree — which is ALSO built from document folderPaths — keeps showing the
// deleted folder even though list-folders would no longer report it.
function removeDocumentsUnder(folderPath: string): void {
  const norm = folderPath.replace(/[\\/]+$/, '').replace(/\//g, sep)
  const prefix = norm + sep
  for (const d of [...storeList()]) {
    const fp = d.filePath.replace(/\//g, sep)
    if (fp === norm) continue // the folder itself, not a document
    if (fp.startsWith(prefix)) storeDelete(d.id)
  }
}

// `io` is the filesystem port (defaults to the real node:fs adapter). Injecting a fake
// is what lets the tests drive every handler without a real disk — see lib/disk-io.ts.
export function registerDocumentHandlers(
  ipcMain: IpcMain,
  app: App,
  getMainWindow: () => unknown,
  io: DiskIO = nodeDiskIO,
  isFileSystemCaseSensitiveSeam: () => boolean = isFileSystemCaseSensitive,
): void {
  _app = app
  // Capture the platform seam so `isSamePath` (used by every rename guard) reads the value the
  // caller chose, without the domain rule depending on `process.platform` directly.
  activeIsFileSystemCaseSensitive = isFileSystemCaseSensitiveSeam
  _getMainWindow = getMainWindow as () => {
    webContents: { send: (channel: string, ...args: unknown[]) => void }
    isDestroyed?: () => boolean
  } | null

  // Recursive folder watching: keep the store in sync with the filesystem for every
  // folder the user opened. Handlers are installed here (rather than in
  // model/folderWatcher.ts) so that folderWatcher stays free of any dependency on the
  // document store — otherwise documents.ts and folderWatcher.ts would import each other.
  startFolderWatching({
    onFileAdded: (filePath) => syncAddedFile(filePath, io),
    onFileRemoved: (filePath) => {
      // A rename reaches chokidar as `unlink <old>` + `add <new>`, and the two are not
      // paired: either can be delivered long after the filesystem has moved on. Renaming
      // a.md -> b.md -> back to a.md therefore replays an `unlink` for a.md at a moment
      // when that path EXISTS again and is still the open document — deleting the record
      // then closed the file (and emptied the sidebar). Never trust the removal while
      // the file is still on disk; a genuinely deleted file is gone by now.
      if (io.exists(filePath)) return
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
    // A folder created or removed outside the app (Explorer, another editor, git…). The
    // tree lists folders, so it has to be told — and it is the PARENT that has to re-read
    // its children: the affected folder itself may be long gone by the time we look.
    onDirAdded: (dirPath) => notifyFolderChanged(dirname(dirPath)),
    onDirRemoved: (dirPath) => notifyFolderChanged(dirname(dirPath)),
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

      // When an absolute folder path is supplied (e.g. the
      // renderer's activeFolder), write directly there (VS Code "save into the
      // opened folder" semantics). A relative sub-folder name is still joined onto
      // the default docs dir to preserve the legacy behavior.
      const baseDir = folderPath
        ? isAbsolute(folderPath)
          ? folderPath
          : join(getDefaultDocsDir(io), folderPath)
        : getDefaultDocsDir(io)
      io.mkdir(baseDir, { recursive: true })

      // Create the file atomically with O_EXCL ('wx'): it must NOT already exist. A name
      // clash is a user-facing error (the sidebar already blocks the commit live, so this
      // only catches a race), not something to silently rename away — appending `-N` would
      // create a file the user never asked for (VS Code refuses the name instead).
      const safeTitle = title.replace(/[/\\:*?"<>|]/g, '-')
      const filePath = join(baseDir, `${safeTitle}${ext}`)
      const fd = io.openExclusive(filePath)
      try {
        io.writeToFd(fd, content)
      } finally {
        io.closeFd(fd)
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

      // Resolve a title change into a real rename BEFORE writing anything. A taken name is
      // refused outright: silently appending `-N` (as this used to do) moved the file to a name
      // the user never chose. Refusing up front also means a refusal leaves nothing written
      // behind — the content write below is skipped rather than landing under the old name.
      let renameTarget: string | null = null
      if (newTitle && newTitle !== existing.title && existing.filePath) {
        const dir = dirname(existing.filePath)
        const safeTitle = newTitle.replace(/[/\\:*?"<>|]/g, '-')
        const ext = extname(existing.filePath).toLowerCase() || '.md'
        const target = join(dir, `${safeTitle}${ext}`)
        // Compare against the file's own path so saving the SAME title (or a caller passing the
        // display form `notes.md`) never counts as a collision with itself.
        if (target !== existing.filePath) {
          if (io.exists(target)) {
            // EEXIST is the standard code for "the name is taken"; the renderer's save-failure
            // path surfaces the message, so no extra plumbing is needed here.
            throw Object.assign(
              new Error(`A file named "${basename(target)}" already exists here.`),
              { code: 'EEXIST' },
            )
          }
          renameTarget = target
        }
      }

      // Write to file (suppress the "file changed" notification that this write would otherwise trigger)
      // Write back in the document's original metadata encoding to preserve byte-level fidelity (R5).
      // A memory-only draft (file_path === '') has no file yet; the first Save is always routed to
      // Save As, so this branch is defensive only. Skip the disk write to avoid writing to an empty path.
      if (existing.filePath) {
        io.writeFile(existing.filePath, iconv.encode(newContent, existing.encoding || 'utf-8'))
        // Suppress the "file changed" notification this write raises. Anchored after the
        // write rather than before it: the watcher reports once the file settles, so a
        // slow write would otherwise outlive the window and pop a bogus prompt.
        markOwnWrite(existing.filePath)
      }

      // Rename file if title changed
      let newFilePath = existing.filePath
      if (renameTarget) {
        io.rename(existing.filePath, renameTarget)
        newFilePath = renameTarget
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

      io.mkdir(dirname(newFilePath), { recursive: true })
      // Save As: write back in the source document's original encoding (the copy inherits that encoding, R5).
      io.writeFile(newFilePath, iconv.encode(content, existing.encoding || 'utf-8'))
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
      ;({ text, encoding, confidence } = readMarkdownText(existing.filePath, io))
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

  // Delete document — move the file to the OS trash rather than permanently deleting it
  // A memory-only draft has no file on disk
  // (file_path === ''); it is discarded from the store without touching the filesystem.
  // trashItem is asynchronous and rejects on failure; per Electron's guidance we must NOT
  // silently fall back to a permanent delete — if the move fails we keep the original file
  // and still drop the store record so the UI stays consistent.
  ipcMain.handle('documents:delete', async (_event, id: string) => {
    const existing = storeGet(id)
    if (!existing) return false

    if (existing.filePath) {
      try {
        await shell.trashItem(existing.filePath)
      } catch (e) {
        // A file already removed externally is not a failure. Any other rejection
        // (no permission, trash unavailable) keeps the original file on disk; we
        // only log it — never fall back to a permanent unlink.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to move file to trash:', e)
        }
      }
    }

    return storeDelete(id)
  })

  // Resolve an appdoc:// URL to its on-disk absolute path. Reuses the
  // security layer in appdoc.ts (doc lookup → containment → exists). Returns null for
  // malformed URLs, escapes, or missing files; callers must handle the null (the
  // renderer greys out / skips the menu item).
  ipcMain.handle('documents:resolve-appdoc', (_event, src: string) => {
    try {
      return resolveAppdocPath(src)
    } catch {
      return null
    }
  })

  // R9 (plan-03 §4.4): resolve intrinsic image dimensions without decoding the whole
  // file — we read only the header (capped at MAX_HEADER_BYTES) and feed it to image-size.
  // Cached by path so repeated keystrokes don't re-read disk. Returns null for malformed /
  // escaping / missing URLs. The read goes through the standard `node:fs` boundary (not
  // image-size's internal reader) so the handler stays mockable under the unit suite's
  // in-memory fs.
  const imageSizeCache = new Map<string, { width: number; height: number }>()
  const MAX_HEADER_BYTES = 512 * 1024
  ipcMain.handle('documents:image-size', async (_event, src: string) => {
    const p = resolveAppdocPath(src)
    if (!p) return null
    const cached = imageSizeCache.get(p)
    if (cached) return cached
    try {
      const handle = await fsPromises.open(p, 'r')
      try {
        const input = Buffer.alloc(MAX_HEADER_BYTES)
        const { bytesRead } = await handle.read(input, 0, MAX_HEADER_BYTES, 0)
        const dims = imageSize(input.subarray(0, bytesRead))
        if (!dims?.width || !dims?.height) {
          imageSizeCache.delete(p)
          return null
        }
        const size = { width: dims.width, height: dims.height }
        imageSizeCache.set(p, size)
        return size
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  })

  // Re-detect a file's encoding without modifying its bytes. Reads the raw
  // buffer and runs the same detector used on import. Returns utf-8 / confidence 0 on any
  // read error so the caller (the encoding re-detect menu item) can fall back gracefully.
  ipcMain.handle('documents:detect-encoding', (_event, filePath: string) => {
    try {
      const buf = io.readFile(filePath)
      return detectEncoding(buf)
    } catch {
      return { enc: 'utf-8', confidence: 0 }
    }
  })

  // Set the line endings of a file on disk. Destructive write: it rewrites the
  // file with the chosen EOL, so the renderer must confirm first and reload afterwards.
  // The document's stored encoding is preserved byte-for-byte (R5). Fails silently when the
  // file is gone or unreadable.
  ipcMain.handle('documents:set-eol', (_event, filePath: string, eol: '\r\n' | '\n') => {
    try {
      const buf = io.readFile(filePath)
      const enc = storeGetByPath(filePath)?.encoding ?? 'utf-8'
      const text = iconv.decode(buf, enc)
      const normalized =
        eol === '\r\n'
          ? text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
          : text.replace(/\r\n/g, '\n')
      io.writeFile(filePath, iconv.encode(normalized, enc))
      markOwnWrite(filePath)
    } catch {
      // Unreadable / missing file: the renderer's confirm+reload is best-effort.
    }
  })

  // Create a folder on disk and start watching it so files dropped into it show up.
  // Non-recursive on purpose: `mkdir` must reject with EEXIST (not silently swallow it
  // the way `recursive: true` would) when the name already exists, so the sidebar's
  // create row can surface the clash. The parent always exists in our flows, so we never
  // need mkdir to create ancestors.
  ipcMain.handle('documents:create-folder', (_event, folderPath: string) => {
    io.mkdir(folderPath, { recursive: false })
    addWatchedFolder(folderPath)
  })

  // Single-slot rename history. Only the MOST RECENT rename can be undone (a full stack was
  // deliberately not built: see docs.local/todo-rename-undo). Owned here, in the main process,
  // because the undo has to re-point the tracked records exactly like the rename did.
  let lastRename: { kind: 'file' | 'folder'; oldPath: string; newPath: string } | null = null
  function rememberRename(kind: 'file' | 'folder', oldPath: string, newPath: string): void {
    lastRename = { kind, oldPath, newPath }
  }

  // Rename a folder on disk. The watcher is told about the new path; chokidar
  // tolerates the old one ceasing to exist. Tracked documents are re-pointed proactively,
  // otherwise the rename reaches the store as unrelated unlink/add pairs and the sidebar
  // shows the old folder (struck-through "missing") beside a duplicate of the new one.
  // VS Code's rule, mirrored here: only Linux treats paths as case-sensitive. On Windows/macOS
  // `a.md` and `A.md` are the SAME file, so a rename that only changes the case is not a move
  // onto a different file — and must not be mistaken for a collision with itself.
  // Same file? Identical paths always are; off a case-sensitive filesystem a name
  // that differs only in case is too. The case-sensitivity fact comes from the
  // injectable platform seam (see docs/adr/0014-*.md), never a direct `process.platform` read.
  function isSamePath(a: string, b: string): boolean {
    return arePathsSame(a, b, activeIsFileSystemCaseSensitive())
  }

  // Refuse a rename whose target name is already taken. POSIX `rename()` SILENTLY REPLACES the
  // target (Windows already errors), so without this guard a collision is silent data loss —
  // the same "refuse, never silently clobber or renumber" rule create/update already follow.
  // The renderer's live check normally prevents it; this is the backstop for a race.
  function guardRenameTarget(io: DiskIO, oldPath: string, newPath: string): void {
    if (isSamePath(oldPath, newPath)) return
    if (!io.exists(newPath)) return
    throw Object.assign(
      new Error(`A file or folder named "${basename(newPath)}" already exists here.`),
      { code: 'EEXIST' },
    )
  }

  ipcMain.handle('documents:rename-folder', (_event, oldPath: string, newPath: string) => {
    guardRenameTarget(io, oldPath, newPath)
    io.rename(oldPath, newPath)
    addWatchedFolder(newPath)
    rePointFolderRecords(oldPath, newPath)
    rememberRename('folder', oldPath, newPath)
  })

  // Rename a single file on disk. Parallel to rename-folder but for one document: the
  // watcher is not told about a new folder (the file stays inside an already-watched one),
  // and the one tracked record is re-pointed (title + path) so the sidebar keeps the same
  // document under the new name with no stale duplicate. Renaming is a direct on-disk move,
  // independent of any open editor / edit mode, so it persists immediately.
  ipcMain.handle('documents:rename-file', (_event, oldPath: string, newPath: string) => {
    guardRenameTarget(io, oldPath, newPath)
    io.rename(oldPath, newPath)
    rePointFileRecord(oldPath, newPath)
    rememberRename('file', oldPath, newPath)
  })

  // Undo the most recent rename — the reverse of the move that was made, plus the same
  // record re-pointing so no stale duplicate is left behind.
  // Single slot by design. It is NOT bound to a global Ctrl+Z: the renderer only calls it
  // when focus is in the sidebar, so the editor keeps Ctrl+Z for text undo.
  ipcMain.handle('documents:undo-rename', () => {
    const last = lastRename
    if (!last) return { ok: false, reason: 'none' as const }
    // Refuse instead of clobbering: the old name may have been taken again since the rename,
    // or the renamed file may itself have been moved on / deleted.
    if (!io.exists(last.newPath)) return { ok: false, reason: 'gone' as const }
    if (io.exists(last.oldPath)) return { ok: false, reason: 'occupied' as const }
    try {
      io.rename(last.newPath, last.oldPath)
    } catch (e) {
      console.error('Failed to undo rename:', e)
      return { ok: false, reason: 'failed' as const }
    }
    if (last.kind === 'folder') {
      addWatchedFolder(last.oldPath)
      rePointFolderRecords(last.newPath, last.oldPath)
    } else {
      rePointFileRecord(last.newPath, last.oldPath)
    }
    lastRename = null
    notifyFolderChanged(dirname(last.oldPath))
    return { ok: true, reason: 'none' as const, oldPath: last.oldPath }
  })

  // List every directory beneath `folderPath` (recursive, depth-capped) so the sidebar
  // tree can show folders that hold no Markdown file. The tree is otherwise derived from
  // documents alone, which has no node to represent an empty folder — and a folder the
  // user just created is always empty. Hidden directories are skipped: .git/.cache are
  // noise in a document workspace and can be enormous.
  ipcMain.handle('documents:list-folders', (_event, folderPath: string) => {
    const MAX_DEPTH = 8
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH) return
      let entries: DirEntry[]
      try {
        entries = io.readdir(dir)
      } catch {
        // Unreadable or already gone: report what we have instead of throwing into IPC.
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        out.push(full)
        walk(full, depth + 1)
      }
    }
    walk(folderPath, 0)
    return out
  })

  // Delete a folder and everything beneath it. Move it to the OS
  // trash rather than permanently deleting — matching the document delete and VS
  // Code behaviour. trashItem rejects on failure; per Electron's guidance we must NOT silently
  // fall back to a permanent delete, so a non-ENOENT rejection is re-thrown (the caller logs it
  // and keeps the folder in the tree). A folder already gone (ENOENT) is treated as success.
  ipcMain.handle('documents:delete-folder', async (_event, folderPath: string) => {
    const resolved = resolve(folderPath)
    const parent = dirname(resolved)
    // Release the watcher first: on Windows a directory that chokidar still holds open
    // cannot be moved to the Recycle Bin, and the OS reports that as a permissions error
    // (see pauseFolderWatching). Without this, deleting a folder INSIDE the currently
    // open workspace — the common case — fails while looking like an ACL problem.
    await pauseFolderWatching()
    try {
      try {
        await shell.trashItem(resolved)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to move folder to trash:', e)
          throw e
        }
      }
    } finally {
      // Restored even when the trash move throws, so a failed delete cannot leave the
      // workspace permanently unwatched.
      resumeFolderWatching()
    }
    // The watcher was paused during the move, so it never observed the deletion and
    // resume() does not replay removals. Mirror what the watcher WOULD have emitted:
    // drop the documents that lived inside the folder (the sidebar tree is also derived
    // from document folderPaths, so leaving them would keep the folder visible), and ask
    // the parent directory to re-read its children so the tree refreshes.
    removeDocumentsUnder(resolved)
    notifyFolderChanged(parent)
  })

  // Import markdown file from disk
  ipcMain.handle('documents:import', (_event, filePath: string) => {
    let text: string
    let encoding: string
    let confidence: number
    try {
      ;({ text, encoding, confidence } = readMarkdownText(filePath, io))
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
        parsed = readMarkdownText(filePath, io)
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
    let handle: ReadHandle | undefined
    try {
      handle = await io.openForRead(filePath)
      const buf = await handle.read(65536)
      const sample = buf.toString('utf-8')
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
      const st = io.stat(filePath)
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
      buf = io.readFile(existing.filePath)
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
