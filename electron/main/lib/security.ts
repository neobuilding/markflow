// 安全相关工具：appdoc:// 协议的 MIME 映射与“二次包含性校验”。
// 抽到独立模块，供主进程 index.ts 与 ipc/export.ts 共同复用，
// 避免 export.ts 直接 import index.ts 触发其顶层副作用（registerSchemesAsPrivileged）重入。
import { extname, sep } from 'path'
import { realpathSync } from 'fs'

// appdoc:// 协议可返回的图片 MIME 映射。
export const APPDOC_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

// 二次包含性校验：递归解析符号链接后比较真实路径，确认 child 仍位于 parent 内
// （防 ../ 穿越与符号链接逃逸，§4.5）。
export function isSubdir(parent: string, child: string): boolean {
  const realParent = realpathSync(parent)
  const realChild = realpathSync(child)
  return realChild === realParent || realChild.startsWith(realParent + sep)
}

// 解析 appdoc://<docId>/<相对路径>。
// 关键坑：new URL('appdoc://doc-123/a.png') 会把 doc-123 解析进 hostname、
// pathname 仅为 '/a.png'（docId 不在 pathname 首段）。故 docId 优先取 hostname，
// 以 pathname 首段做兜底；相对路径取 pathname 并做 percent-decode，
// 使文件名含空格/中文等特殊字符（浏览器会编码为 %20 / %E4%B8%AD 等）能正确还原。
// 非法形态（非 appdoc 协议、缺相对路径）返回 null，由调用方按“不内联/404”处理。
export function parseAppDocUrl(input: string): { docId: string; relPath: string } | null {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    return null
  }
  if (u.protocol !== 'appdoc:') return null
  const docId = u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0]
  const raw = u.pathname.replace(/^\/+/, '')
  if (!docId || !raw) return null
  let relPath: string
  try {
    relPath = decodeURIComponent(raw)
  } catch {
    relPath = raw
  }
  return { docId, relPath }
}
