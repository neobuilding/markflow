// Preview link navigation. A markdown-it link keeps its raw href (`target.md`), but without a
// <base> tag Chromium resolves it against the APP SHELL url (http://localhost:5174 in dev,
// file://<app install dir>/index.html in a packaged build). A left-click therefore navigated the
// whole Electron window away from the React app — blank window, no UI, no way back.
//
// Every link click in the preview is intercepted here and routed deliberately (ADR-0038 §3.1):
//   - local *.md / *.mdx -> open that document in the same app window;
//   - http(s) / mailto / tel -> OS default handler after confirmation;
//   - other local files -> OS default handler via shell.openPath, after confirmation;
//   - #anchor -> scroll inside the preview;
//   - dangerous/unknown schemes (javascript:, data:, appdoc:, ...) -> ignore.
// Relative paths resolve against the ACTIVE DOCUMENT's directory; a leading `/` resolves against
// the WORKSPACE ROOT (VS Code semantics), never against location.href.
import type { ExternalOpenChoice } from '../../../../shared/linkTypes'
import { arePathsSame } from '../../../../shared/fileUtils'

export type PreviewLinkTarget =
  | { kind: 'document'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'localFile'; path: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'ignored' }

const SCHEME = /^([a-z][a-z\d+.-]*):/i
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i
const MARKDOWN_FILE = /\.(md|mdx)$/i

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// Convert a file: URL back to a native path. Chromium's URL parser is used for all segment
// normalisation ("..", ".", percent escapes), so this only strips the scheme wrapper.
function fileUrlToPath(url: URL): string | null {
  if (url.protocol !== 'file:' || url.host) return null
  let pathname = decodePathPart(url.pathname)
  // file:///C:/dir/file.md -> C:/dir/file.md (Node accepts forward slashes on Windows).
  if (/^\/[a-z]:/i.test(pathname)) pathname = pathname.slice(1)
  return pathname
}

// One file: base builder for both document paths and directory paths. The directory form keeps a
// trailing slash so a relative href resolves INSIDE the folder instead of replacing its last
// segment. `new URL('/x', base)` would jump to the drive root, so workspace-root-relative links
// are stripped of their leading slash before being resolved against this base.
function pathToFileUrl(path: string, directory = false): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = /^[a-z]:/i.test(normalized)
    ? `file:///${normalized}`
    : normalized.startsWith('/')
      ? `file://${normalized}`
      : `file:///${normalized}`
  return directory ? `${base}/` : base
}

/** Resolve a preview anchor href against the document being displayed (and the workspace root). */
export function resolvePreviewLink(
  href: string,
  docFilePath: string | null | undefined,
  workspaceRoot?: string | null,
): PreviewLinkTarget {
  const raw = href.trim()
  if (!raw) return { kind: 'ignored' }

  if (raw.startsWith('#')) return { kind: 'anchor', id: decodePathPart(raw.slice(1)) }

  // A Windows drive path is an absolute LOCAL path, not a URL scheme (`C:` would be read as one).
  // markdown-it percent-escapes backslashes, so the href that reaches the DOM is `C:%5Cdir%5C…`;
  // decode before the drive test or the encoded form is misread as an unknown `c:` scheme. The
  // other branches keep the raw href (decoding an http URL could change its query semantics).
  const decodedRaw = decodePathPart(raw)
  if (WINDOWS_DRIVE.test(decodedRaw)) {
    try {
      return localOrDocument(new URL(`file:///${decodedRaw.replace(/\\/g, '/')}`))
    } catch {
      return { kind: 'ignored' }
    }
  }

  const scheme = raw.match(SCHEME)?.[1].toLowerCase()
  if (scheme) {
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') {
      return { kind: 'external', url: raw }
    }
    if (scheme === 'file') {
      try {
        return localOrDocument(new URL(raw))
      } catch {
        return { kind: 'ignored' }
      }
    }
    // javascript:, data:, appdoc:, etc. must never navigate the app shell.
    return { kind: 'ignored' }
  }

  // Protocol-relative URL (//host/path) — treat as a normal web link, never as a local file.
  if (raw.startsWith('//')) return { kind: 'external', url: `https:${raw}` }

  // A leading `/` is workspace-root-relative, not drive-root-relative (ADR-0038 §3.1.2). With no
  // workspace there is no root to resolve it against, so the link is ignored.
  if (raw.startsWith('/')) {
    if (!workspaceRoot) return { kind: 'ignored' }
    try {
      return localOrDocument(new URL(raw.replace(/^\/+/, ''), pathToFileUrl(workspaceRoot, true)))
    } catch {
      return { kind: 'ignored' }
    }
  }

  if (!docFilePath) return { kind: 'ignored' }
  try {
    return localOrDocument(new URL(raw, pathToFileUrl(docFilePath)))
  } catch {
    return { kind: 'ignored' }
  }
}

function localOrDocument(url: URL): PreviewLinkTarget {
  const path = fileUrlToPath(url)
  if (!path) return { kind: 'ignored' }
  return MARKDOWN_FILE.test(path) ? { kind: 'document', path } : { kind: 'localFile', path }
}

/**
 * Compare two native file paths across `/` and `\`, case-insensitively.
 *
 * The case-insensitive fold is deliberate for navigation-history and workspace matching: paths here
 * come from the OS document store and a user-typed link may differ in case from the on-disk name;
 * folding keeps both as one entry (the Windows/macOS rule). On a case-sensitive filesystem (Linux)
 * two files differing only in case are distinct — a known, accepted limitation of this comparison
 * (ADR-0038 §3.4). Renderer callers that need platform-exact identity should use `arePathsSame`
 * with `pathCaseSensitive()` from `lib/utils` instead.
 */
export function sameFilePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return arePathsSame(a.replace(/\\/g, '/'), b.replace(/\\/g, '/'), false)
}

export interface FollowLinkDeps {
  listDocuments: () => Promise<Array<{ id: string; filePath: string }>>
  importDocument: (path: string) => Promise<{ id: string } | null>
  selectDocument: (id: string) => Promise<boolean>
  /** ADR-0038 §3.2: replace the workspace when the target file lives in another folder. */
  navigateToDocument?: (path: string) => Promise<boolean>
  openExternal: (url: string) => void
  openLocalFile: (path: string) => void
  copyTarget: (target: string) => void
  confirmOpenTarget: (target: string) => Promise<ExternalOpenChoice>
}

/**
 * Carry out a resolved preview link. Existing documents are re-used by path instead of being
 * re-imported, so a linked doc with unsaved edits is not clobbered by a disk refresh. External
 * targets (web or local non-Markdown) always go through the Open / Copy / Cancel confirmation
 * before the OS handler sees them (ADR-0038 §3.1.3).
 */
export async function followPreviewLink(target: PreviewLinkTarget, deps: FollowLinkDeps) {
  try {
    if (target.kind === 'document') {
      if (deps.navigateToDocument) {
        await deps.navigateToDocument(target.path)
        return
      }
      const listed = await deps.listDocuments()
      const existing = listed.find((doc) => sameFilePath(doc.filePath, target.path))
      const doc = existing ?? (await deps.importDocument(target.path))
      if (doc) {
        await deps.selectDocument(doc.id)
      } else {
        // An unresolvable target is a no-op — a bad link never crashes or navigates.
        return
      }
      return
    }
    if (target.kind !== 'external' && target.kind !== 'localFile') return

    const value = target.kind === 'external' ? target.url : target.path
    const choice = await deps.confirmOpenTarget(value)
    if (choice === 'cancel') return
    if (choice === 'copy') {
      deps.copyTarget(value)
      return
    }
    if (target.kind === 'external') deps.openExternal(target.url)
    else deps.openLocalFile(target.path)
  } catch {
    // A bad link is a no-op, never a crash and never a window navigation.
  }
}
