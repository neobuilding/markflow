// Security utilities: MIME mapping for the appdoc:// protocol and "secondary
// containment" checks. Extracted into a standalone module so the main process
// (index.ts) and ipc/export.ts can share it without export.ts importing index.ts
// and re-triggering its top-level side effects (registerSchemesAsPrivileged).
import { sep, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

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
  let realChild: string
  try {
    realChild = realpathSync(child)
  } catch {
    // The child may not exist yet (e.g. a still-missing image, or a path that
    // escapes the base dir entirely). Fall back to a non-failing resolve so we
    // can still judge containment by lexical comparison below — this keeps the
    // traversal check robust when realpathSync would otherwise throw ENOENT.
    realChild = resolve(child)
  }
  return realChild === realParent || realChild.startsWith(realParent + sep)
}

// Parse appdoc://<docId>/<relativePath>.
// Requires the canonical appdoc://<docId>/<relPath> form: docId must be in the
// hostname, the hostname must be a plain identifier (alphanumeric, -, _), and the
// relative path must be non-empty. This avoids confusing docId with a path segment
// (e.g. appdoc:doc-123/a.png) and blocks malformed hostnames.
// Percent-decode the path so filenames with spaces / non-ASCII characters
// (the browser encodes them as %20 / %E4%B8%AD etc.) are restored correctly.
// Invalid forms (non-appdoc protocol, missing relative path) return null; the caller
// treats that as "do not inline / 404".
const DOC_ID_RE = /^[a-zA-Z0-9_-]+$/

export function parseAppDocUrl(input: string): { docId: string; relPath: string } | null {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    return null
  }
  // Require the canonical appdoc://<docId>/<relPath> form so the docId is always
  // in the hostname and cannot be confused with a path segment.
  if (u.protocol !== 'appdoc:' || !u.hostname) return null
  const docId = u.hostname
  if (!DOC_ID_RE.test(docId)) return null
  const raw = u.pathname.replace(/^\/+/, '')
  if (!raw) return null
  let relPath: string
  try {
    relPath = decodeURIComponent(raw)
  } catch {
    relPath = raw
  }
  return { docId, relPath }
}
