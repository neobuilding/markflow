// Body matching for the Search view and the cross-file replace pipeline (ADR-0023).
//
// Two modes share ONE compiled matcher (D30 / §13.5):
//
//   * literal (default): the query is ONE literal phrase — spaces belong to the query, there is no
//     implicit AND/OR, no regex and no word-boundary expansion. This mirrors ripgrep's
//     `--fixed-strings`, which is what VS Code uses for non-regex search: `Machine Learning` only
//     matches that contiguous phrase, and a file containing `Machine` and `Learning` separately is
//     not a hit.
//   * regexp (opt-in, `.*`): the query is a JS regular expression, with the literal two-character
//     sequence `\n` expanded so multi-line matches are expressible (§13.6).
//
// Display, counting, hit offsets and replacement MUST all go through this module — "shows 4 hits
// but rewrites 6" is exactly the failure the shared matcher prevents.
import type { SearchMatch } from '../../../shared/searchTypes'
import { createWordIndex, type WordIndex } from './word-boundary'

export const EXCERPT_MAX = 120

export interface MatchOptions {
  matchCase: boolean
  regexp: boolean
  wholeWord: boolean
}

export interface ScanResult {
  /** Capped at `max`: for DISPLAY only. Never use `.length` as the hit count. */
  matches: SearchMatch[]
  /** The real number of non-overlapping hits. */
  total: number
  capped: boolean
}

interface RawMatch {
  start: number
  end: number
  /** Present only in regex mode: carries the capture groups the replacement may expand. */
  exec?: RegExpExecArray
}

export type ScannerFactoryResult =
  { ok: true; factory: ScannerFactory } | { ok: false; message: string }

export interface ScannerFactory {
  /** Display scan: matches carry the line number, the excerpt and the line span. */
  scan(content: string, max: number): ScanResult
  /** The real number of non-overlapping hits. */
  count(content: string): number
  /** New text plus the number of replacements — the same number `scan` reports, by construction. */
  replace(content: string, replacement: string): { text: string; count: number }
  /**
   * Replace ONLY the occurrence starting at `start` ("Replace Here"). Returns count 0 when the
   * offset is not a real hit in the CURRENT text — the plan is computed later, so the bytes may
   * have moved since the user clicked.
   */
  replaceOne(content: string, start: number, replacement: string): { text: string; count: number }
}

// Compare two single UTF-16 code units case-insensitively WITHOUT changing string length.
// Lower-casing a whole string is unsafe for offsets: a handful of code points (notably `İ`
// U+0130) lowercase to MORE than one code unit, so every index after them would shift and the
// editor would jump to the wrong place. Folding per code unit and refusing to fold when the
// result is not exactly one code unit keeps indices aligned with the source text.
function eqFold(a: number, b: number): boolean {
  if (a === b) return true
  const fa = String.fromCharCode(a).toLowerCase()
  const fb = String.fromCharCode(b).toLowerCase()
  if (fa.length !== 1 || fb.length !== 1) return false
  return fa === fb
}

// Naive-but-index-safe scanner. Used only when the fast path below is unavailable (see
// `createLiteralStep`); correctness of offsets beats speed in that rare case.
function scanFold(hay: string, needle: string, from: number): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (!eqFold(hay.charCodeAt(i + j), needle.charCodeAt(j))) continue outer
    }
    return i
  }
  return -1
}

// ─── Literal mode ──────────────────────────────────────────────────────────────────────────────

function createLiteralStep(
  content: string,
  query: string,
  matchCase: boolean,
): (from: number) => number {
  if (matchCase) return (from) => content.indexOf(query, from)
  const hay = content.toLowerCase()
  const needle = query.toLowerCase()
  // Fast path: when lower-casing preserved every code unit (true for essentially all real text),
  // indices in `hay` are valid indices in `content`, so we can use `indexOf` and stay O(n).
  if (hay.length === content.length) return (from) => hay.indexOf(needle, from)
  return (from) => scanFold(content, query, from)
}

// ─── Regex mode ────────────────────────────────────────────────────────────────────────────────

// Turn the literal two-character sequence `\n` into a pattern that matches any line terminator
// (D36). The haystack is NOT normalised: bodies may be CRLF — MarkFlow preserves line endings on
// save — and normalising would shift every offset after the first line, so `start` would no longer
// be a valid CodeMirror position.
//
// `\r` is left alone: JS already reads it as CR, and keeping it lets a user target CR precisely.
// Escapes are copied verbatim, so `\\n` (a literal backslash then n) is NOT rewritten. Inside a
// character class the rewrite is skipped too — `[\n]` would become `[(?:...)]`, which is broken.
export function expandNewlineEscapes(source: string): string {
  let out = ''
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\' && i + 1 < source.length) {
      const next = source[i + 1]
      // Emitted as ESCAPE TEXT, not as raw control characters: the pattern is shown to the user in
      // diagnostics, and `\r\n` reads correctly where an actual line break would not.
      out += !inClass && next === 'n' ? '(?:\\r\\n|\\r|\\n)' : c + next
      i += 1
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    out += c
  }
  return out
}

// Expand `$1` / `$&` / `$$` / `$<name>` — regex mode ONLY. In literal mode `$1` is written
// verbatim, which is what keeps D24's "the query is a literal phrase" invariant intact.
function expandReplacement(replacement: string, exec: RegExpExecArray): string {
  let out = ''
  for (let i = 0; i < replacement.length; i++) {
    if (replacement[i] !== '$' || i + 1 >= replacement.length) {
      out += replacement[i]
      continue
    }
    const next = replacement[i + 1]
    i += 1
    if (next === '$') out += '$'
    else if (next === '&') out += exec[0]
    else if (next === '`') out += exec.input.slice(0, exec.index)
    else if (next === "'") out += exec.input.slice(exec.index + exec[0].length)
    else if (next === '<') {
      const close = replacement.indexOf('>', i)
      if (close === -1) {
        out += '$<'
        continue
      }
      const name = replacement.slice(i + 1, close)
      out += exec.groups?.[name] ?? ''
      i = close
    } else if (next >= '0' && next <= '9') {
      out += exec[Number(next)] ?? ''
    } else {
      out += '$' + next
    }
  }
  return out
}

// ─── Shared driver ─────────────────────────────────────────────────────────────────────────────

// One document, scanned left to right, non-overlapping. `step` yields the mode's raw candidates
// (which may be zero-length in regex mode); whole-word filtering is applied here so both modes
// share the same definition of a word boundary.
function iterate(
  content: string,
  step: (from: number) => RawMatch | null,
  wordIndex: WordIndex | null,
  visit: (m: RawMatch) => void,
): number {
  let total = 0
  let from = 0
  for (;;) {
    const raw = step(from)
    if (!raw) break
    // Zero-length matches are skipped rather than counted: `x*` matching nothing cannot be
    // highlighted, so counting it would report a hit the user cannot see. The `+1` also keeps
    // `exec` from stalling on `lastIndex`.
    const width = raw.end - raw.start
    if (width === 0) {
      from = raw.start + 1
      continue
    }
    if (wordIndex && !(wordIndex.isWordStart(raw.start) && wordIndex.isWordEnd(raw.end))) {
      from = raw.start + Math.max(width, 1)
      continue
    }
    total += 1
    visit(raw)
    from = raw.end
  }
  return total
}

// The hit that starts exactly at `start`, or null. Boxed in an object because it is filled from a
// callback — TypeScript narrows a `let` captured that way to `never`.
function firstAt(
  content: string,
  step: (from: number) => RawMatch | null,
  wholeWord: boolean,
  start: number,
): RawMatch | null {
  const box: { raw: RawMatch | null } = { raw: null }
  iterate(content, step, wholeWord ? createWordIndex(content) : null, (raw) => {
    if (box.raw === null && raw.start === start) box.raw = raw
  })
  return box.raw
}

function countLines(content: string, start: number, end: number): number {
  let lines = 1
  for (let i = start; i < end; i++) {
    if (content[i] === '\n') lines += 1
  }
  return lines
}

// Hits arrive in ascending order, so the line cursor only ever moves forward and the whole scan
// stays O(content) instead of O(content × hits).
interface LineCursor {
  lineStart: number
  line: number
}

function advanceCursor(content: string, cursor: LineCursor, at: number): void {
  for (;;) {
    const nl = content.indexOf('\n', cursor.lineStart)
    const lineEnd = nl === -1 ? content.length : nl
    if (at < lineEnd || nl === -1) break
    cursor.lineStart = nl + 1
    cursor.line += 1
  }
}

function buildMatch(content: string, raw: RawMatch, cursor: LineCursor): SearchMatch {
  const lineStart = cursor.lineStart
  const nl = content.indexOf('\n', lineStart)
  const lineEnd = nl === -1 ? content.length : nl
  const lineText = content.slice(lineStart, lineEnd)
  const excerpt = lineText.slice(0, EXCERPT_MAX)
  const relFrom = raw.start - lineStart
  const relTo = raw.end - lineStart
  let excerptStart = relFrom
  let excerptEnd = relTo
  if (relFrom >= EXCERPT_MAX) {
    // The hit starts past the truncation point: nothing of it survives, so the highlight collapses
    // to the end of the excerpt rather than wrapping an unrelated range.
    excerptStart = EXCERPT_MAX
    excerptEnd = EXCERPT_MAX
  } else if (relTo > EXCERPT_MAX) {
    excerptEnd = EXCERPT_MAX
  }
  return {
    line: cursor.line,
    start: raw.start,
    end: raw.end,
    lineSpan: countLines(content, raw.start, raw.end),
    excerpt,
    excerptStart,
    excerptEnd,
  }
}

/**
 * Compile one query for one set of mode flags. Compiled ONCE per query and then applied to every
 * document — never per document (§13.5).
 *
 * Returns `{ ok: false }` when the user's regex does not compile. The caller MUST surface that as
 * a blocking diagnostic; falling back to a literal search would silently change what matches.
 */
export function createScanner(query: string, opts: MatchOptions): ScannerFactoryResult {
  if (!query) return { ok: false, message: 'empty query' }

  if (opts.regexp) {
    let re: RegExp
    try {
      // `g` is required to walk the matches. `i` iff case-insensitive — never a `toLowerCase()`
      // of the haystack, which would break offsets. `m` is deliberately NOT set: `^`/`$` anchor
      // the whole document, and JS has no inline modifier group (`(?m)` throws), so line anchoring
      // is simply not offered (§13.5).
      re = new RegExp(expandNewlineEscapes(query), opts.matchCase ? 'g' : 'gi')
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    const step =
      (content: string) =>
      (from: number): RawMatch | null => {
        re.lastIndex = from
        const exec = re.exec(content)
        if (!exec) return null
        return { start: exec.index, end: exec.index + exec[0].length, exec }
      }
    return {
      ok: true,
      factory: {
        scan(content, max) {
          if (!content) return { matches: [], total: 0, capped: false }
          const matches: SearchMatch[] = []
          const cursor: LineCursor = { lineStart: 0, line: 1 }
          let capped = false
          const total = iterate(
            content,
            step(content),
            opts.wholeWord ? createWordIndex(content) : null,
            (raw) => {
              advanceCursor(content, cursor, raw.start)
              if (matches.length < max) matches.push(buildMatch(content, raw, cursor))
              else capped = true
            },
          )
          return { matches, total, capped }
        },
        count(content) {
          if (!content) return 0
          return iterate(
            content,
            step(content),
            opts.wholeWord ? createWordIndex(content) : null,
            () => {},
          )
        },
        replace(content, replacement) {
          if (!content) return { text: content, count: 0 }
          let out = ''
          let cursor = 0
          const count = iterate(
            content,
            step(content),
            opts.wholeWord ? createWordIndex(content) : null,
            (raw) => {
              // `exec` is always present in this mode: the regex step is its only producer.
              const text = expandReplacement(replacement, raw.exec!)
              out += content.slice(cursor, raw.start) + text
              cursor = raw.end
            },
          )
          if (count === 0) return { text: content, count: 0 }
          return { text: out + content.slice(cursor), count }
        },
        replaceOne(content, start, replacement) {
          if (!content) return { text: content, count: 0 }
          const found = firstAt(content, step(content), opts.wholeWord, start)
          if (!found) return { text: content, count: 0 }
          // The regex step always carries the exec array, so there is nothing to fall back to here.
          const text = expandReplacement(replacement, found.exec!)
          return {
            text: content.slice(0, found.start) + text + content.slice(found.end),
            count: 1,
          }
        },
      },
    }
  }

  const queryLength = query.length
  return {
    ok: true,
    factory: {
      scan(content, max) {
        if (!content) return { matches: [], total: 0, capped: false }
        const find = createLiteralStep(content, query, opts.matchCase)
        const matches: SearchMatch[] = []
        const cursor: LineCursor = { lineStart: 0, line: 1 }
        let capped = false
        const total = iterate(
          content,
          (from) => {
            const at = find(from)
            return at === -1 ? null : { start: at, end: at + queryLength }
          },
          opts.wholeWord ? createWordIndex(content) : null,
          (raw) => {
            advanceCursor(content, cursor, raw.start)
            if (matches.length < max) matches.push(buildMatch(content, raw, cursor))
            else capped = true
          },
        )
        return { matches, total, capped }
      },
      count(content) {
        if (!content) return 0
        const find = createLiteralStep(content, query, opts.matchCase)
        return iterate(
          content,
          (from) => {
            const at = find(from)
            return at === -1 ? null : { start: at, end: at + queryLength }
          },
          opts.wholeWord ? createWordIndex(content) : null,
          () => {},
        )
      },
      replace(content, replacement) {
        if (!content) return { text: content, count: 0 }
        const find = createLiteralStep(content, query, opts.matchCase)
        let out = ''
        let cursor = 0
        const count = iterate(
          content,
          (from) => {
            const at = find(from)
            return at === -1 ? null : { start: at, end: at + queryLength }
          },
          opts.wholeWord ? createWordIndex(content) : null,
          (raw) => {
            out += content.slice(cursor, raw.start) + replacement
            cursor = raw.end
          },
        )
        if (count === 0) return { text: content, count: 0 }
        return { text: out + content.slice(cursor), count }
      },
      replaceOne(content, start, replacement) {
        if (!content) return { text: content, count: 0 }
        const find = createLiteralStep(content, query, opts.matchCase)
        const found = firstAt(
          content,
          (from) => {
            const at = find(from)
            return at === -1 ? null : { start: at, end: at + queryLength }
          },
          opts.wholeWord,
          start,
        )
        if (!found) return { text: content, count: 0 }
        return {
          text: content.slice(0, found.start) + replacement + content.slice(found.end),
          count: 1,
        }
      },
    },
  }
}
