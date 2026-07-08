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
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

// 返回文件路径的目录部分（跨平台，统一正斜杠）
export function dirName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx <= 0 ? '' : norm.slice(0, idx)
}

// 判断某个文件的目录是否位于 folder 内（含 folder 自身），大小写不敏感（Windows）
export function isInFolder(filePath: string, folder: string): boolean {
  if (!folder) return false
  const f = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const d = dirName(filePath).replace(/\\/g, '/').toLowerCase()
  return d === f || d.startsWith(f + '/')
}

// 返回文件路径的文件名部分（含扩展名），跨平台，统一正斜杠
export function baseName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx < 0 ? norm : norm.slice(idx + 1)
}

function normalizePathSegments(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

// 将字节数格式化为人类可读的字符串（B / KB / MB / GB）
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

// 将时间戳格式化为完整日期时间（详情对话框使用）
export function formatDateTime(ts: number): string {
  if (!ts || ts <= 0) return '—'
  return new Date(ts).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// ─── 侧边栏子文件夹树 ──────────────────────────────────────────────
export interface FileTreeNode {
  /** 文件夹名或文件名（不含路径） */
  name: string
  /** 文件夹为绝对目录路径；文件为绝对文件路径；保证唯一可作为 key */
  path: string
  isFolder: boolean
  /** 仅文件节点携带对应的文档 */
  doc?: Document
  children: FileTreeNode[]
}

// 根据一组文档与根文件夹，构建出嵌套的子文件夹 / 文件树。
// 文档的 folder_path 可能为空，因此统一从 filePath 推导相对目录层级。
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
      let child = node.children.find((c) => c.isFolder && c.name.toLowerCase() === seg.toLowerCase())
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
      children: []
    })
  }

  // 排序：文件夹优先，其次按名称字母序
  const sortRec = (n: FileTreeNode) => {
    n.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    n.children.forEach(sortRec)
  }
  sortRec(root)

  return root.children
}
