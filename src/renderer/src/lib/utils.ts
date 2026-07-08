import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

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
