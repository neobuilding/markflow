import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Document } from '../types'

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

// Whether a directory path is `folder` itself or inside it (its subtree); case-insensitive
// (Windows), tolerant of backslashes and a trailing separator on either argument.
export function isDirInFolder(dirPath: string, folder: string): boolean {
  if (!folder) return false
  const f = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const d = dirPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return d === f || d.startsWith(f + '/')
}

// Whether a file's directory is inside `folder` (including folder itself); case-insensitive (Windows)
export function isInFolder(filePath: string, folder: string): boolean {
  return isDirInFolder(dirName(filePath), folder)
}

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

// Must stay in sync with MD_EXTS in electron/main/lib/markdown-ext.ts.
const MD_EXT_RE = /\.(md|markdown|mdx|mdtxt|mdtext)$/i

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
