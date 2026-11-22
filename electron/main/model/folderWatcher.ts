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
import { getWorkspaceRoot } from './workspaceRoot'
import { allContexts, currentContext, withContext, type WindowContext } from './windowContext'

export type FolderWatchHandlers = {
  // A Markdown file appeared under a watched folder.
  onFileAdded: (filePath: string) => void
  // A Markdown file disappeared from a watched folder.
  onFileRemoved: (filePath: string) => void
  // A Markdown file's contents changed and we did not cause the write ourselves.
  onFileChanged: (filePath: string) => void
  // A directory appeared / disappeared (created, deleted or moved by another program).
  // The sidebar tree lists FOLDERS, not just Markdown files, so a folder holding no
  // Markdown produces no file event at all — without these the tree would keep showing
  // a folder that no longer exists. Optional: file-only callers need not supply them.
  onDirAdded?: (dirPath: string) => void
  onDirRemoved?: (dirPath: string) => void
}

export type FolderEvent = 'add' | 'unlink' | 'change'
// chokidar's directory equivalents, dispatched separately because `dispatch` filters on
// the Markdown extension (which no directory has).
export type DirEvent = 'addDir' | 'unlinkDir'

// Directories never worth crawling: dot dirs (notably .git, .DS_Store) and
// node_modules.
const IGNORED_DIRS: RegExp[] = [/(^|[/\\])\.[^/\\]*/, /[/\\]node_modules([/\\]|$)/]

// Which paths chokidar should WATCH.
//
// This is the expensive decision, not `dispatch`'s isMarkdownFile check: watching
// costs a recursive crawl plus a watch handle per entry, and that cost is paid for
// EVERY file regardless of whether its events are later used. The previous config
// only excluded a handful of extensions, so in a real workspace chokidar watched
// all 680 files (build output, coverage reports, images, sources) while only 16
// of them were markdown and ~97% of the events it paid for were then discarded
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

// Kept as a `Matcher[]` so callers could still extend it;
// the function form is supported (chokidar's own example uses
// `(f, stats) => stats?.isFile() && !f.endsWith('.js')`).
const IGNORED = [shouldIgnore]

// How long a write performed by us suppresses the "changed externally" signal.
// Saving is write-then-return, and the watcher sees the write asynchronously, so
// without this every save would immediately prompt the user to reload their own edit.
const OWN_WRITE_SUPPRESS_MS = 2000
// Cap on the suppression map; it is pruned opportunistically when it grows past this.
const OWN_WRITE_MAX_ENTRIES = 256

// All watcher state is per-window. A WeakMap keyed by WindowContext keeps this module's API
// unchanged (every function reads the active context via ALS) while preventing one window's
// watcher events, own-write suppression and pause state from leaking into another window.
interface WatcherState {
  ownWrites: Map<string, number>
  watcher: FSWatcher | null
  externalWatchers: Map<string, FSWatcher>
  handlers: FolderWatchHandlers | null
  watchingPaused: boolean
}
const states = new WeakMap<WindowContext, WatcherState>()

// The handler set is installed ONCE per process (ipc/documents.ts registers the document
// handlers at startup, before any window exists), but the watcher state is PER WINDOW. A
// window that opens its workspace later still needs those handlers, so the installed set is
// remembered here and seeded into every state created afterwards.
//
// Without this, the second window's watcher fired into a state whose `handlers` were still
// null: every event was dropped, and the sidebar of that window never refreshed.
let installedHandlers: FolderWatchHandlers | null = null

function state(): WatcherState {
  const ctx = currentContext()
  let s = states.get(ctx)
  if (!s) {
    s = {
      ownWrites: new Map(),
      watcher: null,
      externalWatchers: new Map(),
      handlers: installedHandlers,
      watchingPaused: false,
    }
    states.set(ctx, s)
  }
  return s
}

function isOwnWrite(filePath: string): boolean {
  const { ownWrites } = state()
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
  const { ownWrites } = state()
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
  const h = state().handlers
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

// Test seam for the directory path, mirroring __emitFolderEvent.
export function __emitFolderDirEvent(event: DirEvent, dirPath: string): void {
  dispatchDir(event, dirPath)
}

// Directory events get their own dispatch: `dispatch` drops every non-Markdown path, which
// is exactly every directory. `shouldIgnore` already keeps chokidar out of dot-directories
// and node_modules, so what arrives here is a real, user-visible folder.
function dispatchDir(event: DirEvent, dirPath: string): void {
  const h = state().handlers
  if (!h) return
  if (event === 'addDir') h.onDirAdded?.(dirPath)
  else h.onDirRemoved?.(dirPath)
}

// Start chokidar over the single workspace root, or return null when there is nothing to watch
// yet (the user has not opened a folder). The root is ONE path by construction (ADR-0023),
// so there is no folder set to iterate and no ordering question to answer.
function createWatcher(): FSWatcher | null {
  const root = getWorkspaceRoot()
  if (!root) return null
  // The watcher belongs to ONE window. chokidar calls its listeners from a native event,
  // i.e. OUTSIDE any ALS scope, so every callback is re-entered in the OWNING window's
  // scope: that is what makes the store the handlers mutate this window's store, and what
  // makes `state()` resolve this window's watcher state (own-write suppression included).
  const ctx = currentContext()
  const w = watch(root, {
    ignored: IGNORED,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    // Wait for a write to settle before reporting it, so half-written files are
    // not read into the store (and so our own save has been committed already).
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  })
  w.on('add', (p) => withContext(ctx, () => dispatch('add', p)))
  w.on('unlink', (p) => withContext(ctx, () => dispatch('unlink', p)))
  w.on('change', (p) => withContext(ctx, () => dispatch('change', p)))
  // Directory create/remove, so the folder tree follows changes made outside the app.
  w.on('addDir', (p) => withContext(ctx, () => dispatchDir('addDir', p)))
  w.on('unlinkDir', (p) => withContext(ctx, () => dispatchDir('unlinkDir', p)))
  w.on('error', () => {
    // Individual unreadable paths are already filtered by ignorePermissionErrors;
    // swallow anything left so a stray watcher error cannot crash the main process.
  })
  return w
}

// Watch one workspace-external Markdown file. Idempotent per path. Called after such a document
// is imported; a delete/re-create of the file makes chokidar drop the handle, so callers may call
// again on re-import to re-arm it (the old handle is closed first).
export function watchExternalFile(filePath: string): void {
  const { externalWatchers } = state()
  if (externalWatchers.has(filePath)) return
  // Same scope rule as the folder watcher: the callbacks run in the window that armed them.
  const ctx = currentContext()
  const w = watch(filePath, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  })
  w.on('change', (p) => withContext(ctx, () => dispatch('change', p)))
  w.on('unlink', (p) => withContext(ctx, () => dispatch('unlink', p)))
  w.on('error', () => {
    /* a vanished external file is reported by unlink; swallow stray watch errors */
  })
  externalWatchers.set(filePath, w)
}

// Stop watching one external file. Called when the document that owned the watch is deleted,
// so the watch follows the document's lifetime instead of living until the workspace changes.
export async function unwatchExternalFile(filePath: string): Promise<void> {
  const { externalWatchers } = state()
  const w = externalWatchers.get(filePath)
  if (!w) return
  externalWatchers.delete(filePath)
  await w.close()
}

// Install the store-mutation callbacks. Called once, from registerDocumentHandlers;
// the watcher itself is only started once a folder has actually been opened.
// Re-entrant safe: re-installing handlers must not orphan a watcher that is already
// running (it would keep firing events into the new handlers and never be closed).
export function startFolderWatching(h: FolderWatchHandlers): void {
  installedHandlers = h
  const s = state()
  s.handlers = h
  if (s.watcher) return
  s.watcher = createWatcher()
}

// (Re)build the watcher from the current root. Used when the root is replaced or re-pointed
// (opening a folder, renaming the root): the previous handle watched a path that is either gone or
// no longer the whole story, so it is closed rather than extended.
export function refreshFolderWatching(): void {
  const s = state()
  const previous = s.watcher
  s.watcher = null
  // Q28: external documents do not survive a workspace switch, so their watches go too.
  for (const [path, w] of s.externalWatchers) {
    void w.close().catch(
      // A close() rejection is not actionable — the watcher is being discarded regardless, so
      // the handler never does anything and never runs in tests.
      /* v8 ignore next */
      () => {},
    )
    s.externalWatchers.delete(path)
  }
  if (previous)
    void previous.close().catch(
      // A close() rejection is not actionable — the watcher is being replaced regardless, so the
      // handler never does anything and never runs in tests.
      /* v8 ignore next */
      () => {},
    )
  // A pause is in flight (a folder deletion released the handles on purpose): do not start a
  // watcher behind the pause's back — `resumeFolderWatching` owns that transition.
  if (s.watchingPaused) return
  s.watcher = createWatcher()
}

// Temporarily release every watch handle, keeping the single workspace root intact so the
// watch can be restored afterwards.
//
// Windows cannot move a directory to the Recycle Bin while anything still holds an open
// handle on it, and chokidar holds one per watched directory. So deleting a folder that
// lives INSIDE the watched tree fails — the OS surfaces it as a permissions / "folder in
// use" error even though nothing is actually wrong with the ACLs. Releasing the watch
// first is what makes "delete folder" work for a subfolder of the open workspace.
// Only markdown files are watched, but directories are always traversed (and therefore
// held open), which is why even a folder containing no Markdown is affected.
// Set only between pause and resume, so a resume can never start a watcher that was
// not running before (and a pause is idempotent if something already paused).

export async function pauseFolderWatching(): Promise<void> {
  const s = state()
  if (s.watchingPaused) return
  const w = s.watcher
  // Nothing is being watched (no folder open yet) — there is no handle to release.
  if (!w) return
  s.watchingPaused = true
  s.watcher = null
  await w.close()
}

// Restore the watch after pauseFolderWatching(). A no-op unless a pause actually
// happened, so it can never create a watcher that was not there before.
export function resumeFolderWatching(): void {
  const s = state()
  if (!s.watchingPaused) return
  s.watchingPaused = false
  // Defensive: a pause always nulls `watcher`, so by the time we resume there is nothing to keep.
  /* v8 ignore next */
  if (s.watcher) return
  s.watcher = createWatcher()
}

// Stop watching everything (workspace closed, or app quitting) and drop the
// suppression map so a restarted watcher starts from a clean slate.
// The handlers are deliberately kept: they are installed once for the process
// lifetime, so opening a folder after a stop picks up right where it left off.
//
// ONE window's watches, always: `ctx` names that window explicitly, and without it the
// CURRENT window is resolved through the ALS scope. Callers that run inside an IPC handler
// therefore stop only their own window — switching the workspace in one window must not
// tear down another window's watcher. App shutdown uses stopAllFolderWatching() below,
// which is the ONLY way to stop every window at once.
export async function stopFolderWatching(ctx?: WindowContext): Promise<void> {
  const s = states.get(ctx ?? currentContext())
  if (!s) return
  const w = s.watcher
  s.watcher = null
  s.ownWrites.clear()
  const externals = [...s.externalWatchers.values()]
  s.externalWatchers.clear()
  await Promise.all(externals.map((ew) => ew.close()))
  if (w) await w.close()
}

/**
 * Stop EVERY window's watches — the app-shutdown path (will-quit).
 *
 * chokidar holds native filesystem handles, and a handle owned by a window that is no longer
 * around keeps the process alive after the last window closed. So the shutdown path must
 * release every registered context, not just whichever one happens to be active.
 *
 * `allContexts` is imported STATICALLY on purpose. A dynamic `import('./windowContext')`
 * here would be bundled as a SEPARATE chunk that carries its OWN copy of the registry
 * (its own `contexts` Map and its own AsyncLocalStorage), so the shutdown path would see an
 * empty registry and close nothing; and on the will-quit path the pending module load
 * stalled the process teardown entirely (the app could not exit). The static import shares
 * the one registry this module already reads through `currentContext()`.
 */
export async function stopAllFolderWatching(): Promise<void> {
  await Promise.all(allContexts().map((ctx) => stopFolderWatching(ctx)))
  // The headless fallback context (no window registered) can still hold a watcher.
  await stopFolderWatching()
}
