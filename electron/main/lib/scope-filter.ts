// The Search view's scope model (ADR-0023).
//
// Scope is a pair of VISIBLE, PATH-EXPRESSED include / exclude fields — never a hidden mode bit.
// Both fields are matched against each document's path RELATIVE to the single `workspaceRoot`
// (D13); the root is never derived from a "watched folder set".
import { parsePatternList, matchPattern, type ParsedPattern } from './patterns'
import { relativePath } from '../../../shared/fileUtils'
import type { DiskIO } from './disk-io'
import type { SearchDiagnostic } from '../../../shared/searchTypes'

export interface ScopeMatcher {
  root: string | null
  include: ParsedPattern[]
  exclude: ParsedPattern[]
}

export interface ScopeBuildResult {
  scope: ScopeMatcher
  diagnostics: SearchDiagnostic[]
  /** True when a blocking diagnostic is present: the caller MUST return zero results (D27). */
  blocking: boolean
}

// A path-type entry (`./docs`) that does not exist under the root. Reported so a typo reads as
// "that folder does not exist" instead of silently degrading into a whole-root search.
function missingPaths(patterns: ParsedPattern[], root: string | null, io: DiskIO): string[] {
  if (!root) return []
  const missing: string[] = []
  for (const p of patterns) {
    if (!p.isPath) continue
    // The first candidate is the bare path; the second is `<path>/**`, which is never a direct
    // filesystem entry.
    const rel = p.candidates[0]
    // Defensive: a path pattern always has a non-empty first candidate (see expandOne).
    /* v8 ignore next */
    if (!rel) continue
    if (!io.exists(`${root}/${rel}`)) missing.push(p.raw)
  }
  return missing
}

/**
 * Build a scope from the two raw user strings.
 *
 * Fail-closed by construction (D27): a pattern we cannot parse does not get dropped — it makes the
 * whole query blocking, because dropping a *narrowing* condition silently WIDENS the scope, and a
 * widened scope is exactly what a subsequent "Replace All" would write into.
 */
export function buildScope(
  include: string | undefined,
  exclude: string | undefined,
  root: string | null,
  io: DiskIO,
): ScopeBuildResult {
  const diagnostics: SearchDiagnostic[] = []
  const inc = parsePatternList(include, root)
  const exc = parsePatternList(exclude, root)

  const firstError = inc.errors[0] ?? exc.errors[0]
  const errorField = inc.errors.length > 0 ? 'include' : 'exclude'
  if (firstError) {
    return {
      scope: { root, include: [], exclude: [] },
      diagnostics: [
        {
          code: 'invalid-pattern',
          field: errorField,
          pattern: firstError.raw,
          blocking: true,
          message: firstError.message,
        },
      ],
      blocking: true,
    }
  }

  // No root means no relative path exists, so scope cannot be evaluated at all — but an EMPTY
  // scope is still fine: that is the "search in-memory drafts only" case.
  const hasScope = inc.patterns.length > 0 || exc.patterns.length > 0
  if (hasScope && !root) {
    return {
      scope: { root, include: [], exclude: [] },
      diagnostics: [
        {
          code: 'no-workspace-root',
          blocking: true,
          message: 'no workspace root: include/exclude cannot be applied',
        },
      ],
      blocking: true,
    }
  }

  // A missing INCLUDE path is a narrowing condition that silently vanished — fail-closed: block
  // (D27). A missing EXCLUDE path is harmless (excluding nothing changes no result), so it is
  // surfaced as a non-blocking diagnostic and the search proceeds rather than being mislabelled as
  // an include problem (a typo in the exclude box must not block the whole search).
  const includeMissing = missingPaths(inc.patterns, root, io)
  if (includeMissing.length > 0) {
    return {
      scope: { root, include: [], exclude: [] },
      diagnostics: [
        {
          code: 'path-not-found',
          field: 'include',
          pattern: includeMissing[0],
          blocking: true,
          message: `path not found under the workspace root: ${includeMissing[0]}`,
        },
      ],
      blocking: true,
    }
  }
  const excludeMissing = missingPaths(exc.patterns, root, io)
  if (excludeMissing.length > 0) {
    diagnostics.push({
      code: 'path-not-found',
      field: 'exclude',
      pattern: excludeMissing[0],
      blocking: false,
      message: `exclude path not found under the workspace root: ${excludeMissing[0]}`,
    })
  }

  return {
    scope: { root, include: inc.patterns, exclude: exc.patterns },
    diagnostics,
    blocking: false,
  }
}

// The document's path relative to the root, or `null` when there is no root / no file / the file
// lives outside the root (D20 says the last case should not exist, but it must not produce a
// bogus `rel` if it ever does).
export function relToRoot(filePath: string, root: string | null): string | null {
  if (!filePath || !root) return null
  const rel = relativePath(filePath, root)
  if (rel === filePath.replace(/\\/g, '/')) return null
  return rel
}

/**
 * Whether a document is in scope.
 *
 * `rel === null` means "memory-only draft". Drafts have no path to match, so they take part only
 * when BOTH fields are empty (D19) — note "either non-empty" excludes them, not "both non-empty".
 */
export function inScope(rel: string | null, scope: ScopeMatcher): boolean {
  if (rel === null) return scope.include.length === 0 && scope.exclude.length === 0
  // Exclude wins: VS Code's rule, and the only rule that makes "exclude to override include"
  // expressible.
  if (scope.exclude.some((p) => matchPattern(rel, p))) return false
  if (scope.include.length > 0 && !scope.include.some((p) => matchPattern(rel, p))) return false
  return true
}

// Diagnostics that describe how the scope narrowed the candidate set — never blocking, but the UI
// has to be able to explain "your drafts were left out" rather than looking like a bug.
export function scopeDiagnostics(
  scope: ScopeMatcher,
  draftCount: number,
  outOfRootCount: number,
): SearchDiagnostic[] {
  const out: SearchDiagnostic[] = []
  if (draftCount > 0 && (scope.include.length > 0 || scope.exclude.length > 0)) {
    out.push({
      code: 'drafts-excluded',
      blocking: false,
      message: 'memory-only drafts are excluded while a scope is set',
    })
  }
  if (outOfRootCount > 0) {
    out.push({
      code: 'out-of-root-skipped',
      blocking: false,
      message: `${outOfRootCount} document(s) outside the workspace root were skipped`,
    })
  }
  return out
}
