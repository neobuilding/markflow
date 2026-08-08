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

// Whether a file's directory is inside `folder` (including folder itself); case-insensitive (Windows)
export function isInFolder(filePath: string, folder: string): boolean {
  if (!folder) return false
  const f = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const d = dirName(filePath).replace(/\\/g, '/').toLowerCase()
  return d === f || d.startsWith(f + '/')
}

// Return the file-name part of a path (with extension); cross-platform, normalized to forward slashes
export function baseName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx < 0 ? norm : norm.slice(idx + 1)
}

function normalizePathSegments(filePath: string): string {
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
export function buildFileTree(docs: Document[], rootFolder: string): FileTreeNode[] {
  const rootNorm = normalizePathSegments(rootFolder).replace(/\/$/, '').toLowerCase()
  const root: FileTreeNode = { name: '', path: rootFolder, isFolder: true, children: [] }

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
