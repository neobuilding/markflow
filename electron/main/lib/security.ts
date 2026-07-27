// Security utilities: MIME mapping for the appdoc:// protocol and "secondary
// containment" checks. Extracted into a standalone module so the main process
// (index.ts) and ipc/export.ts can share it without export.ts importing index.ts
// and re-triggering its top-level side effects (registerSchemesAsPrivileged).
import { extname, sep } from 'path'
import { realpathSync } from 'fs'

// MIME map for images the appdoc:// protocol may return.
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

// Secondary containment check: resolve symlinks recursively, then compare real
// paths to confirm child is still inside parent (blocks ../ traversal and symlink
// escapes, see §4.5).
export function isSubdir(parent: string, child: string): boolean {
  const realParent = realpathSync(parent)
  const realChild = realpathSync(child)
  return realChild === realParent || realChild.startsWith(realParent + sep)
}

// Parse appdoc://<docId>/<relativePath>.
// Gotcha: new URL('appdoc://doc-123/a.png') puts doc-123 into hostname and leaves
// pathname as just '/a.png' (docId is not the first path segment). So prefer hostname
// for docId and fall back to the first path segment; take the relative path from
// pathname and percent-decode it so filenames with spaces / non-ASCII characters
// (the browser encodes them as %20 / %E4%B8%AD etc.) are restored correctly.
// Invalid forms (non-appdoc protocol, missing relative path) return null; the caller
// treats that as "do not inline / 404".
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
