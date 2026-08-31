// Recursive folder watching (phase two of removing the database layer).
//
// Replaces the per-document / per-directory `fs.watch` handlers that used to live
// in ipc/documents.ts. Two capabilities are provided here:
//
//   1. Files created or deleted anywhere under an opened folder (at any depth) are
//      reflected into the in-memory document store, so the sidebar refreshes.
//   2. Files modified by another program still raise `app:file-changed`, which the
//      renderer turns into the "reload?" prompt.
//
// The module deliberately knows nothing about the document store or about reading
// Markdown: the caller installs three callbacks via startFolderWatching() and owns
// the store mutation. That keeps the dependency graph acyclic (ipc/documents.ts ->
// model/folderWatcher.ts) even though documents.ts is also the installer.
import { watch, type FSWatcher } from 'chokidar'
import { isMarkdownFile } from '../lib/markdown-ext'
import { addOpenFolder, clearOpenFolders, getOpenFolders } from './openFolders'

export type FolderWatchHandlers = {
  // A Markdown file appeared under a watched folder.
  onFileAdded: (filePath: string) => void
  // A Markdown file disappeared from a watched folder.
  onFileRemoved: (filePath: string) => void
  // A Markdown file's contents changed and we did not cause the write ourselves.
  onFileChanged: (filePath: string) => void
}

export type FolderEvent = 'add' | 'unlink' | 'change'

// Directories never worth crawling: dot dirs (notably .git, .DS_Store) and
// node_modules.
const IGNORED_DIRS: RegExp[] = [/(^|[/\\])\.[^/\\]*/, /[/\\]node_modules([/\\]|$)/]

// Which paths chokidar should WATCH.
//
// This is the expensive decision, not `dispatch`'s isMarkdownFile check: watching
// costs a recursive crawl plus a watch handle per entry, and that cost is paid for
// EVERY file regardless of whether its events are later used. The previous config
// only excluded a handful of extensions, so in a real workspace chokidar watched
// all 680 files (build output, coverage reports, images, sources…) while only 16
// of them were markdown — and ~97% of the events it paid for were then discarded
// by isMarkdownFile in dispatch(). Measured on the markflow repo, that overhead
// showed up as up to 8 main-process stalls of up to 2s right after opening a
// folder; the same run on an 8-file folder had zero stalls.
//
// So: watch markdown only. Directories must still be traversed (chokidar cannot
// recurse into a directory it is told to ignore), hence the isDirectory branch.
function shouldIgnore(path: string, stats?: { isDirectory(): boolean }): boolean {
  const isDir = stats ? stats.isDirectory() : !/\.[^/\\]+$/.test(path)
  if (isDir) return IGNORED_DIRS.some((r) => r.test(path))
  return !isMarkdownFile(path)
}

// Kept as a `Matcher[]` so addOpenFolder-style callers could still extend it;
// the function form is supported (chokidar's own example uses
// `(f, stats) => stats?.isFile() && !f.endsWith('.js')`).
const IGNORED = [shouldIgnore]

// How long a write performed by us suppresses the "changed externally" signal.
// Saving is write-then-return, and the watcher sees the write asynchronously, so
// without this every save would immediately prompt the user to reload their own edit.
const OWN_WRITE_SUPPRESS_MS = 2000
// Cap on the suppression map; it is pruned opportunistically when it grows past this.
const OWN_WRITE_MAX_ENTRIES = 256

const ownWrites = new Map<string, number>()

let watcher: FSWatcher | null = null
let handlers: FolderWatchHandlers | null = null

function isOwnWrite(filePath: string): boolean {
  const until = ownWrites.get(filePath)
  if (until === undefined) return false
  if (Date.now() >= until) {
    ownWrites.delete(filePath)
    return false
  }
  return true
}

// Record that we are about to write `filePath` ourselves, so the resulting watcher
// event is not mistaken for an external modification.
export function markOwnWrite(filePath: string): void {
  ownWrites.set(filePath, Date.now() + OWN_WRITE_SUPPRESS_MS)
  if (ownWrites.size <= OWN_WRITE_MAX_ENTRIES) return
  for (const [path, until] of ownWrites) {
    if (Date.now() > until) ownWrites.delete(path)
  }
}

// Single dispatch point shared by the real chokidar listeners and by the test seam
// below, so tests exercise exactly the production filtering.
function dispatch(event: FolderEvent, filePath: string): void {
  if (!isMarkdownFile(filePath)) return
  if (event === 'change' && isOwnWrite(filePath)) return
  const h = handlers
  if (!h) return
  if (event === 'add') h.onFileAdded(filePath)
  else if (event === 'unlink') h.onFileRemoved(filePath)
  else h.onFileChanged(filePath)
}

// Test seam: drive the dispatch path without starting a real filesystem watcher.
// Production code never calls this.
export function __emitFolderEvent(event: FolderEvent, filePath: string): void {
  dispatch(event, filePath)
}

// Start chokidar over every opened folder, or return null when there is nothing to
// watch yet (the user has not opened a folder).
function createWatcher(): FSWatcher | null {
  const folders = getOpenFolders()
  if (folders.length === 0) return null
  const w = watch(folders, {
    ignored: IGNORED,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    // Wait for a write to settle before reporting it, so half-written files are
    // not read into the store (and so our own save has been committed already).
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  })
  w.on('add', (p) => dispatch('add', p))
  w.on('unlink', (p) => dispatch('unlink', p))
  w.on('change', (p) => dispatch('change', p))
  w.on('error', () => {
    // Individual unreadable paths are already filtered by ignorePermissionErrors;
    // swallow anything left so a stray watcher error cannot crash the main process.
  })
  return w
}

// Install the store-mutation callbacks. Called once, from registerDocumentHandlers;
// the watcher itself is only started once a folder has actually been opened.
// Re-entrant safe: re-installing handlers must not orphan a watcher that is already
// running (it would keep firing events into the new handlers and never be closed).
export function startFolderWatching(h: FolderWatchHandlers): void {
  handlers = h
  if (watcher) return
  watcher = createWatcher()
}

// Register a folder the user opened. Ignored when it is already covered by a
// broader watched folder (e.g. the user drills into a subfolder of an open folder).
export function addWatchedFolder(folderPath: string): void {
  if (!addOpenFolder(folderPath)) return
  if (watcher) {
    watcher.add(folderPath)
    return
  }
  watcher = createWatcher()
}

// Stop watching everything (workspace closed, or app quitting) and drop the
// suppression map so a restarted watcher starts from a clean slate.
// The handlers are deliberately kept: they are installed once for the process
// lifetime, so opening a folder after a stop picks up right where it left off.
export async function stopFolderWatching(): Promise<void> {
  const w = watcher
  watcher = null
  clearOpenFolders()
  ownWrites.clear()
  if (w) await w.close()
}
