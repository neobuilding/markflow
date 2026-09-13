import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Document } from '../types'
// Shared, environment-agnostic case-sensitivity rule (see docs/adr/0014-*.md). The
// renderer keeps its own navigator-based detection (`pathCaseSensitive`) but delegates
// the fold rule itself to this pure module so the rule is defined in exactly one place.
import { foldName as foldNamePure, MD_EXTS } from '../../../../shared/fileUtils'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } else if (diffDays === 1) {
    return 'Yesterday'
  } else if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: 'long' })
  } else {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
}

export function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

// Whether the current platform is macOS (navigator.platform is deprecated; use userAgent)
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad/i.test(navigator.userAgent)
}

// Whether the current platform is Windows (navigator.platform is deprecated; use userAgent)
export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return false
  return /win/i.test(navigator.userAgent)
}

// VS Code's rule verbatim: its diskFileSystemProvider grants `PathCaseSensitive` only when
// `isLinux`, so Windows and macOS treat `Note.md` and `note.md` as the SAME file while Linux
// treats them as two. A name clash therefore has to be detected case-insensitively off Linux.
export function pathCaseSensitive(): boolean {
  return !isMac() && !isWindows()
}

// Fold a name for comparisons the way VS Code folds its child keys in `getPlatformAwareName`:
// lowercased on a case-insensitive filesystem, untouched on a case-sensitive one. The fold
// rule itself is delegated to the shared pure helper (see docs/adr/0014-*.md); only the
// case-sensitivity fact is detected here (browser context → navigator, not process.platform).
export function foldName(name: string): string {
  return foldNamePure(name, pathCaseSensitive())
}

// Render a keyboard shortcut for display, platform-aware.
// Input is the macOS form: '⌘' = primary modifier (Command), '⇧' = Shift. On macOS
// it is returned unchanged; on Windows/Linux '⌘' becomes 'Ctrl+' and '⇧' 'Shift+'.
// e.g. formatShortcut('⌘S')  -> '⌘S'   (macOS) | 'Ctrl+S'       (Windows/Linux)
//      formatShortcut('⌘⇧S') -> '⌘⇧S' (macOS) | 'Ctrl+Shift+S' (Windows/Linux)
// The primary modifier is switched (not the keybindings) handlers already resolve
// ⌘ to Ctrl off macOS (see App.tsx), so this keeps the *label* in sync with reality.
export function formatShortcut(macKeys: string): string {
  if (isMac()) return macKeys
  return macKeys.replace('⌘', 'Ctrl+').replace('⇧', 'Shift+')
}

// Whether the local draft differs from the saved baseline (i.e. has unsaved changes).
// Pure helper so the dirty-computation can be unit-tested independently of React.
export function computeDirty(localContent: string, savedContent: string): boolean {
  return localContent !== savedContent
}

// Return the directory part of a file path (cross-platform, normalized to forward slashes)
export function dirName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx <= 0 ? '' : norm.slice(0, idx)
}

// Path containment is now defined once in shared/fileUtils.ts (single source, shared by
// main and renderer). Re-exported here so existing importers of utils.ts keep working.
export { isInFolder, isDirInFolder } from '../../../../shared/fileUtils'

// Return the file-name part of a path (with extension); cross-platform, normalized to forward slashes
export function baseName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx < 0 ? norm : norm.slice(idx + 1)
}

// Append a name to a directory path (: inline folder create / rename)
// The separator is inferred from `dir` so a Windows path keeps its backslashes
// (the main process receives the path verbatim); trailing separators on `dir`
// are collapsed so callers never produce `a//b`.
export function joinPath(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, '') + (dir.includes('\\') ? '\\' : '/') + name
}

// ─── Document title (file name) helpers ─────────────────────────────────────
// The main process stores `Document.title` WITHOUT the Markdown extension (it is
// derived with stripMarkdownExt when a file is imported), while the title bar shows
// the file name WITH its extension the name the user actually sees in their file
// manager. These helpers convert between the two forms.

// Single-sourced from MD_EXTS in shared/fileUtils.ts (the renderer cannot import the
// main-process markdown-ext.ts, which pulls in node:path). Derive the matcher so the
// extension set lives in exactly one place.
const MD_EXT_RE = new RegExp(`\\.(${[...MD_EXTS].map((e) => e.slice(1)).join('|')})$`, 'i')

// Drop a trailing Markdown extension (`notes.md` -> `notes`, `notes.MD` -> `notes`).
// Non-Markdown names are returned untouched, so callers need no guard.
export function stripMarkdownExt(fileName: string): string {
  return fileName.replace(MD_EXT_RE, '')
}

// Append `.md` when the name carries no Markdown extension yet.
export function withMarkdownExt(fileName: string): string {
  return MD_EXT_RE.test(fileName) ? fileName : `${fileName}.md`
}

// The Markdown extension a file name ends with ('' when it has none).
export function markdownExtOf(fileName: string): string {
  return MD_EXT_RE.exec(fileName)?.[0] ?? ''
}

// The name shown in the title bar (and seeded into the rename input): the file name
// WITH its extension, e.g. `readme.md`.
//
// It comes from the path because `title` is extension-free; a memory-only draft has
// no path yet, so it falls back to the name the first Save As would create. A draft
// with a blank title shows nothing rather than a bare `.md`.
export function displayTitle(doc: Pick<Document, 'title' | 'filePath'> | null | undefined): string {
  if (!doc) return ''
  if (doc.filePath) return baseName(doc.filePath)
  const base = doc.title.trim()
  return base ? withMarkdownExt(base) : ''
}

// Normalize a path's separators to forward slashes (cross-platform, used for
// path matching/comparison without touching the canonical on-disk separator).
export function normalizePathSegments(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

// Format a byte count into a human-readable string (B / KB / MB / GB)
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let i = 0
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(size >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

// Format a timestamp into a full date-time string (used by the details dialog)
export function formatDateTime(ts: number): string {
  if (!ts || ts <= 0) return '—'
  return new Date(ts).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ─── Sidebar subfolder tree ──────────────────────────────────────────
export interface FileTreeNode {
  /** Folder or file name (without path) */
  name: string
  /** Absolute directory path for folders, absolute file path for files; unique, usable as key */
  path: string
  isFolder: boolean
  /** Only file nodes carry the corresponding document */
  doc?: Document
  children: FileTreeNode[]
}

// Build a nested subfolder / file tree from a set of documents and a root folder.
// A document's folder_path may be empty, so the relative directory levels are derived
// from filePath uniformly.
//
// `folders` seeds the tree with the directories that exist on disk (as listed by
// documents:list-folders) so a folder holding no Markdown file still gets a node the
// document set alone cannot represent it. Folder nodes created here keep the on-disk
// casing; the per-document walk below joins them case-insensitively.
export function buildFileTree(
  docs: Document[],
  rootFolder: string,
  folders: readonly string[] = [],
): FileTreeNode[] {
  const rootNorm = normalizePathSegments(rootFolder).replace(/\/$/, '').toLowerCase()
  const rootTrimmed = normalizePathSegments(rootFolder).replace(/\/$/, '')
  const root: FileTreeNode = { name: '', path: rootFolder, isFolder: true, children: [] }

  for (const folder of folders) {
    const folderNorm = normalizePathSegments(folder).replace(/\/$/, '')
    const segments = folderNorm
      .slice(rootTrimmed.length)
      .replace(/^\//, '')
      .split('/')
      .filter(Boolean)
    let node = root
    let currentPath = rootTrimmed
    for (const seg of segments) {
      currentPath += '/' + seg
      let child = node.children.find(
        /* v8 ignore next -- exercised via Sidebar's folderDirs (buildFileTree is called with the
           on-disk folder listing); v8 does not attribute inline arrow callbacks inside a loop
           body, so ignore the find callback + its `&&` branch. */
        (c) => c.isFolder && c.name.toLowerCase() === seg.toLowerCase(),
      )
      /* v8 ignore next -- same loop-body attribution quirk for the `if (!child)` guard. */
      if (!child) {
        child = { name: seg, path: currentPath, isFolder: true, children: [] }
        node.children.push(child)
      }
      node = child
    }
  }

  for (const doc of docs) {
    const dir = dirName(doc.filePath)
    const relSegments = normalizePathSegments(dir)
      .replace(/\/$/, '')
      .toLowerCase()
      .replace(rootNorm, '')
      .split('/')
      .filter(Boolean)

    let node = root
    let currentPath = normalizePathSegments(rootFolder).replace(/\/$/, '')
    for (const seg of relSegments) {
      currentPath += '/' + seg
      let child = node.children.find(
        (c) => c.isFolder && c.name.toLowerCase() === seg.toLowerCase(),
      )
      if (!child) {
        child = { name: seg, path: currentPath, isFolder: true, children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.children.push({
      name: baseName(doc.filePath),
      path: doc.filePath,
      isFolder: false,
      doc,
      children: [],
    })
  }

  // Sort: folders first, then alphabetically by name
  const sortRec = (n: FileTreeNode) => {
    n.children.sort((a, b) => {
      const af = a.isFolder ? 1 : 0
      const bf = b.isFolder ? 1 : 0
      if (af !== bf) return bf - af // folders first (symmetric: works whether a or b is the folder)
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    n.children.forEach(sortRec)
  }
  sortRec(root)

  return root.children
}

// The sidebar's MODEL is the complete picture of the active folder — every directory that
// exists on disk plus every loaded document (see buildFileTree). What the user SEES is this
// filtered view of it. The two are deliberately separate because "is it visible" and "does it
// exist" are different questions: an inline name must be refused when it collides with something
// that exists, even if the filter is currently hiding it.
//
// A folder survives when any of these holds:
//   • 显示所有文件夹 is ON — the user asked to see the document-less ones;
//   • it is pinned (created this session, see Recently-created folder) — a folder must not vanish
//     the instant it is named;
//   • it still has a surviving child — which is exactly "it transitively holds Markdown", plus the
//     ancestor chain of anything kept further down (a pinned deep folder needs its parents).
// File nodes are documents by construction, so they always survive.
//
// Pinned paths arrive in whatever shape the caller holds them (a folder created via a forward-slash
// tree path on Windows, say), so the set is normalized once here rather than at every call site.
export function filterTreeForDisplay(
  nodes: readonly FileTreeNode[],
  {
    showAllFolders,
    pinnedFolders,
  }: { showAllFolders: boolean; pinnedFolders: ReadonlySet<string> },
): FileTreeNode[] {
  const normalize = (p: string): string => normalizePathSegments(p).replace(/\/$/, '').toLowerCase()
  const pinned = new Set([...pinnedFolders].map(normalize))
  const keep = (node: FileTreeNode): FileTreeNode | null => {
    if (!node.isFolder) return node
    const children = node.children
      .map(keep)
      .filter((child): child is FileTreeNode => child !== null)
    const visible = showAllFolders || pinned.has(normalize(node.path)) || children.length > 0
    return visible ? { ...node, children } : null
  }
  return nodes.map(keep).filter((node): node is FileTreeNode => node !== null)
}

// Where the temporary FILE create row belongs inside one parent's children: right after the last
// subfolder and before the first file, which is the seam the folders-first sort already creates.
// `children` is the array that is actually being rendered, so a folder the display filter is
// hiding does not shift the row. The result is a valid splice index in [0, children.length]: a
// parent holding no files (or nothing at all) puts the row last — the same place a brand-new
// file lands after it is committed. A FOLDER create row uses index 0 instead (before the first
// folder); callers decide which based on what is being created.
export function createRowIndex(children: readonly FileTreeNode[]): number {
  const firstFile = children.findIndex((child) => !child.isFolder)
  return firstFile === -1 ? children.length : firstFile
}

// Normalize a path for equality checks: forward slashes only, no trailing separator, so a path the
// OS or a previous session wrote with a trailing slash matches its canonical form.
function canonPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

// Depth-first lookup of the node whose path equals `path`, or undefined. Used to find a parent's
// children when checking for a name clash.
export function findTreeNode(
  nodes: readonly FileTreeNode[],
  path: string,
): FileTreeNode | undefined {
  const target = canonPath(path)
  for (const n of nodes) {
    if (canonPath(n.path) === target) return n
    const hit = findTreeNode(n.children, target)
    if (hit) return hit
  }
  return undefined
}

// The immediate child names of `parentPath` in the COMPLETE tree (every folder + loaded document),
// so a clash is detected against the real siblings the new entry would join — including document-less
// subfolders the display filter hides. The root folder has no node of its own in the tree, so its
// children are the top-level nodes, and an unknown `parentPath` falls back to those too.
export function siblingBasenames(tree: readonly FileTreeNode[], parentPath: string): Set<string> {
  const node = findTreeNode(tree, parentPath)
  const siblings = node ? node.children : tree
  return new Set(siblings.map((c) => baseName(c.path)))
}

// Characters that can never appear in a file or folder name. VS Code splits the typed name on
// separators and validates each segment (so `a/b` may still create nested folders); ours is
// stricter on purpose — mkdir is non-recursive now, so `a/b` could only ever fail, and a name
// that cannot round-trip to Windows is rejected everywhere rather than per-platform.
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/

// True when `name` can never be written as a file or folder name — the equivalent of VS Code's
// "invalidFileNameError": a reserved dot name, or one carrying a separator / Windows-illegal
// character. An empty name is the input's own concern (it cancels), so it is not "invalid" here.
export function invalidBaseName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed === '.' || trimmed === '..') return true
  return INVALID_NAME_CHARS.test(trimmed)
}

// Re-point an `expanded` folder set when a folder is renamed: every entry equal to
// `oldPath` (or beneath it) is rewritten onto `newPath`, so a renamed folder — and any
// descendants it had expanded — keep the same open/closed state under the new name.
// Entries outside the renamed subtree are preserved untouched.
//
// Output paths are normalized to forward slashes because tree node paths (buildFileTree)
// are forward-slash, and `expanded.has(node.path)` must keep matching them.
export function repointExpandedSet(
  expanded: ReadonlySet<string>,
  oldPath: string,
  newPath: string,
): Set<string> {
  const oldNorm = normalizePathSegments(oldPath).replace(/\/$/, '')
  const oldPrefix = oldNorm + '/'
  const newNorm = normalizePathSegments(newPath)
  const next = new Set<string>()
  for (const p of expanded) {
    const pn = normalizePathSegments(p).replace(/\/$/, '')
    if (pn === oldNorm) {
      next.add(newNorm)
    } else if (pn.startsWith(oldPrefix)) {
      next.add(newNorm + pn.slice(oldNorm.length))
    } else {
      next.add(p)
    }
  }
  return next
}
