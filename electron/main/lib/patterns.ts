// include / exclude pattern parsing for the Search view (ADR-0023).
//
// Three rules this module exists to enforce, each of them a correction of an earlier draft:
//
//  1. The comma separator is GLOB-AWARE (D25). `input.split(',')` would turn the perfectly legal
//     character class `[ab,c].md` into the two broken patterns `[ab` and `c].md`. VS Code has the
//     same rule (`splitGlobAware` in `glob.ts`).
//  2. Path patterns and glob patterns expand DIFFERENTLY (D4/D26). Appending `/**` to everything
//     is wrong: `*.md` would miss `a/b.md` and a bare `docs` would miss `docs` at any depth.
//  3. An invalid pattern is FAIL-CLOSED (D27). Dropping it would silently widen the scope — the
//     user could then Replace All into files they never named.
//
// Matching is always against the path RELATIVE to `workspaceRoot`, and is deliberately NOT shared
// with Quick Open's filename glob (`ipc/glob.ts`), which uses `basename:` matchBase semantics.
import picomatch from 'picomatch'
import { relative, isAbsolute } from 'node:path'

export interface ParsedPattern {
  /** The pattern as the user typed it (after trimming + separator normalization). */
  raw: string
  /** Path-type (`./x`, `../x`, absolute) vs. ordinary glob. */
  isPath: boolean
  /** The one or two picomatch patterns this entry expands to; any match counts. */
  candidates: string[]
}

export interface PatternParseError {
  raw: string
  message: string
}

export interface PatternParseResult {
  patterns: ParsedPattern[]
  errors: PatternParseError[]
}

// Split on TOP-LEVEL commas only: commas inside a brace expansion `{a,b}` or a character class
// `[ab,c]` belong to the pattern, as does any comma preceded by a backslash.
export function splitGlobAware(input: string): string[] {
  const out: string[] = []
  let current = ''
  let braces = 0
  let brackets = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\\' && i + 1 < input.length) {
      current += ch + input[i + 1]
      i += 1
      continue
    }
    if (ch === '{') braces += 1
    else if (ch === '}') braces = Math.max(0, braces - 1)
    else if (ch === '[') brackets += 1
    else if (ch === ']') brackets = Math.max(0, brackets - 1)
    if (ch === ',' && braces === 0 && brackets === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

// Stray `}` must be caught by hand: picomatch's `strictBrackets` only throws for brackets it can
// see as UNBALANCED-OPEN, and a lone closing brace (e.g. `**/*.md}`) is silently accepted even
// with strictBrackets on. A negative depth is exactly that case.
function bracesBalanced(pattern: string): boolean {
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0
}

// picomatch's shipped types only declare the option-less `parse` overload, but the runtime honours
// `strictBrackets` (verified against the resolved picomatch 4.x in this repo: `a[bc` and `{a,b`
// throw with it on, and silently parse without it).
const parseStrict = picomatch.parse as unknown as (
  pattern: string,
  options: { strictBrackets: boolean },
) => unknown

// Ask picomatch itself whether the pattern is well-formed. With the DEFAULT options picomatch
// never throws and an invalid pattern simply never matches — undiagnosable, which is precisely
// why D27 requires `strictBrackets: true` plus the brace check above.
function picomatchError(pattern: string): string | null {
  if (!bracesBalanced(pattern)) return 'unbalanced braces'
  try {
    parseStrict(pattern, { strictBrackets: true })
    return null
  } catch (err) {
    // picomatch.parse only ever throws an Error, so the fallback string is unreachable.
    /* v8 ignore next */
    return err instanceof Error ? err.message : 'invalid pattern'
  }
}

// Path-type = what VS Code calls `isSearchPath`: an absolute path, or one starting with
// `./` `../` `.\` `..\`. Anything else is an ordinary glob (matched anywhere under the root).
function isPathPattern(p: string): boolean {
  if (isAbsolute(p)) return true
  return /^\.\.?[/\\]/.test(p)
}

function stripTrailingSlash(p: string): string {
  return p.replace(/[/\\]+$/, '')
}

// Turn one user-written pattern into its candidate globs.
// Returns an error message instead of candidates when the pattern is unusable.
function expandOne(raw: string, root: string | null): { pattern?: ParsedPattern; error?: string } {
  const trimmed = stripTrailingSlash(raw.trim().replace(/\\/g, '/'))
  if (!trimmed) return {}

  if (isPathPattern(trimmed)) {
    // Absolute paths are resolved against the root; `./x` / `.\x` simply shed their prefix.
    // Either way the result must be INSIDE the root — see the `..` checks below (D20).
    let rel: string
    if (isAbsolute(trimmed)) {
      if (!root) return { error: 'absolute path with no workspace root' }
      rel = relative(root, trimmed).replace(/\\/g, '/')
      // `..` means the pattern points outside the single root: there is no relative path for it to
      // match, so it is rejected instead of quietly matching nothing.
      if (rel === '' || rel.startsWith('..')) return { error: 'path is outside the workspace root' }
    } else {
      rel = trimmed.replace(/^\.\//, '')
      if (/^\.\./.test(rel)) return { error: 'path is outside the workspace root' }
    }
    // Defensive: absolute paths with an empty rel are already rejected above, and a `./`-relative
    // path always yields a non-empty `rel`, so this is unreachable.
    /* v8 ignore next */
    if (!rel) return { error: 'empty path' }
    const candidates = rel.endsWith('/**') ? [rel] : [rel, `${rel}/**`]
    const err = candidates.map(picomatchError).find((e) => e !== null)
    if (err) return { error: err }
    return { pattern: { raw: trimmed, isPath: true, candidates } }
  }

  // Ordinary glob: matched at any depth, and (unless it already ends in `**`) also as a prefix
  // of everything below it — so a bare `docs` finds `a/docs` and `a/docs/x.md`.
  const candidates = trimmed.endsWith('**')
    ? [`**/${trimmed}`]
    : [`**/${trimmed}`, `**/${trimmed}/**`]
  const err = candidates.map(picomatchError).find((e) => e !== null)
  if (err) return { error: err }
  return { pattern: { raw: trimmed, isPath: false, candidates } }
}

/**
 * Parse a comma-separated include/exclude field. Empty input yields no patterns and no errors.
 * Callers MUST treat a non-empty `errors` as fail-closed (D27).
 */
export function parsePatternList(
  input: string | undefined | null,
  root: string | null = null,
): PatternParseResult {
  const patterns: ParsedPattern[] = []
  const errors: PatternParseError[] = []
  if (!input || !input.trim()) return { patterns, errors }
  for (const piece of splitGlobAware(input)) {
    if (!piece.trim()) continue // ignore empty items (a trailing comma is not an error)
    const { pattern, error } = expandOne(piece, root)
    if (pattern) patterns.push(pattern)
    else if (error) errors.push({ raw: piece.trim(), message: error })
  }
  return { patterns, errors }
}

// Match a path (relative to the root, forward-slashed) against one parsed pattern.
// `nocase: true` is MarkFlow's deliberate unified case-insensitivity for PATH globs (D16): it is
// not platform-derived, so Windows and Linux CI agree on which files are in scope.
export function matchPattern(rel: string, pattern: ParsedPattern): boolean {
  return pattern.candidates.some((c) => picomatch.isMatch(rel, c, { dot: true, nocase: true }))
}
