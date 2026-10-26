// Resolving ONE workspace root out of whatever the user dropped or opened (ADR-0023).
//
// MarkFlow is a single-root workspace. The renderer used to take `directories[0]` — i.e. whatever
// the OS happened to hand over first — and silently ignored every other directory, whose files
// then never entered the watcher (F21). That is an arbitrary choice presented as a decision.
//
// The rule now:
//   * one directory                       → that directory is the root
//   * only files (no directory)           → the first file's parent directory is the root
//   * several directories, common ancestor → that ancestor is the root
//   * several unrelated directories       → REFUSE (list the candidates, let the user open them
//                                            one at a time) rather than pick one silently.
import { dirName } from './utils'

export type RootResolution =
  | { ok: true; root: string; note: 'directory' | 'single-file' | 'common-ancestor' }
  | { ok: false; reason: 'no-files' | 'multiple-roots'; candidates: string[] }

function segments(p: string): string[] {
  return p
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s.length > 0)
}

// A lone drive letter (`C:`) is a technically-true but useless ancestor: opening it would watch an
// entire volume. Treated as "no common ancestor".
function isDriveOnly(segment: string): boolean {
  return /^[A-Za-z]:$/.test(segment)
}

function rebuild(prefix: string[], sample: string): string {
  const sep = sample.includes('\\') ? '\\' : '/'
  const joined = prefix.join(sep)
  const absolute = /^([/\\])/.test(sample)
  return absolute ? `${sep}${joined}` : joined
}

export function commonAncestor(paths: string[]): string | null {
  const segs = paths.map(segments)
  if (segs.length === 0 || segs.some((s) => s.length === 0)) return null
  const first = segs[0]
  let i = 0
  while (i < first.length && segs.every((s) => s[i] === first[i])) i += 1
  if (i === 0) return null
  if (i === 1 && isDriveOnly(first[0])) return null
  return rebuild(first.slice(0, i), paths[0])
}

export function resolveWorkspaceRoot(
  directories: string[],
  firstMarkdownFile?: string,
): RootResolution {
  const unique = [...new Set(directories.filter((d) => !!d))]
  if (unique.length === 0) {
    if (!firstMarkdownFile) return { ok: false, reason: 'no-files', candidates: [] }
    return { ok: true, root: dirName(firstMarkdownFile), note: 'single-file' }
  }
  if (unique.length === 1) return { ok: true, root: unique[0], note: 'directory' }
  const ancestor = commonAncestor(unique)
  if (ancestor) return { ok: true, root: ancestor, note: 'common-ancestor' }
  return { ok: false, reason: 'multiple-roots', candidates: unique }
}
