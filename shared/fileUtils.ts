// Cross-process, environment-agnostic file & path helpers.
//
// Every function here is PURE and FREE of platform globals: no `process`, no
// `navigator`, no `node:path`. That is deliberate — this module is imported by BOTH
// the main process and the renderer (browser context, where `node:path` and
// `process.platform` are unavailable), so it must stay render-safe. Anything that
// reads an environment fact (e.g. `isFileSystemCaseSensitive`, which reads
// `process.platform`) lives at the edge of the main process in
// `electron/main/lib/disk-io.ts` and is INJECTED into these rules.
//
// See docs/adr/0014-*.md.

// ─── Case-sensitivity rules ──────────────────────────────────────────────────
//
// Whether two paths name the same file, given the filesystem's case sensitivity.
// `a === b` is always the same file; off a case-sensitive filesystem a name that
// differs only in case is likewise the same file.
export function arePathsSame(a: string, b: string, caseSensitive: boolean): boolean {
  return a === b || (!caseSensitive && a.toLowerCase() === b.toLowerCase())
}

// Fold a name for case-insensitive comparison: untouched on a case-sensitive
// filesystem, lowercased otherwise. (VS Code folds child keys the same way in
// `getPlatformAwareName`.)
export function foldName(name: string, caseSensitive: boolean): string {
  return caseSensitive ? name : name.toLowerCase()
}

// ─── Markdown extension set ──────────────────────────────────────────────────
//
// The ONLY set of file extensions the app treats as Markdown. Single-sourced here
// so the main process (markdown-ext.ts), the renderer (utils.ts) and the e2e perf
// fixture all agree; previously it was copied in three places with a "must stay in
// sync" comment. Keep this the one definition.
export const MD_EXTS = new Set(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'])

// ─── Path containment ───────────────────────────────────────────────────────
//
// Whether a file's directory is inside `folder` (including folder itself);
// case-insensitive (Windows), tolerant of backslashes and a trailing separator on
// either argument. Shared by the main process (folderMatch.ts / documentStore)
// and the renderer (tree filtering).
export function isInFolder(filePath: string, folder: string): boolean {
  if (!folder) return false
  const f = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const d = filePath.replace(/\\/g, '/').toLowerCase()
  const idx = d.lastIndexOf('/')
  const dir = idx <= 0 ? '' : d.slice(0, idx)
  return dir === f || dir.startsWith(f + '/')
}

// Whether `dirPath` is `folder` itself or inside it (its subtree);
// case-insensitive (Windows).
export function isDirInFolder(dirPath: string, folder: string): boolean {
  if (!folder) return false
  const f = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const d = dirPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return d === f || d.startsWith(f + '/')
}
