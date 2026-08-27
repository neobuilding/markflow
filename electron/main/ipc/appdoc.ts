// appdoc: protocol handling (privilege / symlink allow-list, C2 / §4.1 / §4.5).
// URL shape: appdoc://<docId>/<relativePath>. The handler looks up file_path by docId
// in the document store, computes docBaseDir, resolves the relative path to an absolute one, then
// runs the secondary containment check; any privilege escape returns 403.
// APPDOC_MIME / isSubdir are defined in ../lib/security (shared with other main-process handlers).
import { protocol } from 'electron'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, extname } from 'node:path'
import { getDocumentById } from '../model/documentStore'
import { parseAppDocUrl, isSubdir, APPDOC_MIME } from '../lib/security'

export function registerAppDocProtocol(): void {
  protocol.handle('appdoc', (request) => {
    try {
      // appdoc://<docId>/<relativePath>: docId is in the hostname and the relative path
      // needs percent-decoding; delegate to parseAppDocUrl (see ../lib/security) to avoid
      // drifting from the export inline logic.
      const parsed = parseAppDocUrl(request.url)
      if (!parsed) {
        return new Response('Not Found', { status: 404 })
      }
      const { docId, relPath } = parsed
      const doc = getDocumentById(docId)
      if (!doc?.filePath) {
        return new Response('Not Found', { status: 404 })
      }
      const docBaseDir = dirname(doc.filePath)
      const resolved = resolve(docBaseDir, relPath)
      // Secondary containment check: block ../ traversal and symlink escapes
      if (!isSubdir(docBaseDir, resolved)) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!existsSync(resolved)) {
        return new Response('Not Found', { status: 404 })
      }
      const data = readFileSync(resolved)
      const mime = APPDOC_MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, {
        headers: {
          'Content-Type': mime,
          // Images must not be readable by any page script, so tighten CSP
          'Content-Security-Policy': "default-src 'none'",
        },
      })
    } catch {
      return new Response('Error', { status: 500 })
    }
  })
}
