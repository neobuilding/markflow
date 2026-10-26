// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  createScanner,
  expandNewlineEscapes,
  EXCERPT_MAX,
  type MatchOptions,
} from './content-match'

const LITERAL: MatchOptions = { matchCase: false, regexp: false, wholeWord: false }

function factoryOf(query: string, opts: Partial<MatchOptions> = {}) {
  const compiled = createScanner(query, { ...LITERAL, ...opts })
  if (!compiled.ok) throw new Error(`expected the query to compile: ${compiled.message}`)
  return compiled.factory
}

const scan = (content: string, query: string, opts: Partial<MatchOptions> = {}, max = 50) =>
  factoryOf(query, opts).scan(content, max)
const count = (content: string, query: string, opts: Partial<MatchOptions> = {}) =>
  factoryOf(query, opts).count(content)
const replace = (
  content: string,
  query: string,
  replacement: string,
  opts: Partial<MatchOptions> = {},
) => factoryOf(query, opts).replace(content, replacement)

describe('literal matching — the query is ONE literal phrase (ADR-0023)', () => {
  it('does not split the query on whitespace', () => {
    // "Machine ... Learning" is NOT a hit for "Machine Learning": an earlier draft split on
    // whitespace, which inflated both the result list and the replace count.
    expect(scan('Machine Learning is here', 'Machine Learning').total).toBe(1)
    expect(scan('Machine ... Learning', 'Machine Learning').total).toBe(0)
  })

  it('distinguishes a double space from a single one', () => {
    expect(scan('a  b', 'a b').total).toBe(0)
  })

  it('never matches a regex or a word boundary', () => {
    expect(scan('a.c abc', 'a.c').total).toBe(1)
    // `a.c` as a regex would also match `abc`; here it must not.
    expect(scan('abc', 'a.c').total).toBe(0)
  })

  it('is case-insensitive by default and case-sensitive when asked', () => {
    expect(scan('Needle', 'needle').total).toBe(1)
    expect(scan('Needle', 'needle', { matchCase: true }).total).toBe(0)
  })

  it('counts non-overlapping occurrences only', () => {
    // "aa" in "aaaa" is two occurrences, not three.
    expect(scan('aaaa', 'aa').total).toBe(2)
  })

  it('keeps offsets aligned even for text whose lowercase changes length', () => {
    // 'İ' (U+0130) lowercases to TWO code units, so lower-casing the whole haystack would shift
    // every index after it and the editor would jump to the wrong place.
    const { matches } = scan('İstanbul x', 'x')
    expect(matches[0].start).toBe(9)
  })

  it('falls back to the index-safe scanner when folding changes length', () => {
    // The `scanFold` path: 'İ' is present, so the fast `indexOf` path is unusable.
    expect(scan('İİ hit', 'hit').matches[0].start).toBe(3)
    expect(scan('İİ HIT', 'hit', { matchCase: true }).total).toBe(0)
  })
})

describe('literal matching — display vs counting (ADR-0023)', () => {
  it('caps what it returns but never what it counts', () => {
    const body = Array.from({ length: 120 }, () => 'hit').join(' ')
    const r = scan(body, 'hit')
    expect(r.matches).toHaveLength(50)
    expect(r.capped).toBe(true)
    // The UI must read `total`, never `matches.length`.
    expect(r.total).toBe(120)
  })

  it('reports line numbers and a truncated excerpt', () => {
    const r = scan('first\nsecond hit here', 'hit')
    expect(r.matches[0]).toMatchObject({ line: 2, start: 13, end: 16 })
    expect(r.matches[0].excerpt).toBe('second hit here')
    expect(r.matches[0].excerptStart).toBe(7)
    expect(r.matches[0].excerptEnd).toBe(10)
  })

  it('reports lineSpan 1 for a literal hit', () => {
    expect(scan('a hit b', 'hit').matches[0].lineSpan).toBe(1)
  })

  it('clamps the highlight range when the hit is past the excerpt cut', () => {
    const line = `${'x'.repeat(EXCERPT_MAX + 5)}hit`
    const r = scan(line, 'hit')
    expect(r.matches[0].excerpt).toHaveLength(EXCERPT_MAX)
    expect(r.matches[0].excerptStart).toBe(EXCERPT_MAX)
    expect(r.matches[0].excerptEnd).toBe(EXCERPT_MAX)
  })

  it('clamps the highlight range when the hit straddles the excerpt cut', () => {
    const line = `${'x'.repeat(EXCERPT_MAX - 2)}hit rest`
    const r = scan(line, 'hit')
    expect(r.matches[0].excerptStart).toBe(EXCERPT_MAX - 2)
    expect(r.matches[0].excerptEnd).toBe(EXCERPT_MAX)
  })

  it('preserves CRLF by locating lines with indexOf rather than split', () => {
    const r = scan('a\r\nb hit', 'hit')
    expect(r.matches[0].line).toBe(2)
    expect(r.matches[0].excerpt).toBe('b hit')
  })
})

describe('counting and replacing agree (whichever mode is on)', () => {
  const cases: Array<[string, string]> = [
    ['hit hit hit', 'hit'],
    ['aaaa', 'aa'],
    ['none', 'hit'],
    ['Case CASE case', 'case'],
  ]
  for (const [text, query] of cases) {
    it(`"${query}" in "${text}": count === replacements`, () => {
      const expected = count(text, query)
      const { text: replaced, count: wrote } = replace(text, query, 'X')
      expect(wrote).toBe(expected)
      expect(replaced.split('X').length - 1).toBe(expected)
    })
  }

  it('deletes the hit when the replacement is empty', () => {
    expect(replace('a hit b', 'hit', '')).toEqual({ text: 'a  b', count: 1 })
  })

  it('returns the input unchanged when there is no hit', () => {
    expect(replace('nothing', 'hit', 'X')).toEqual({ text: 'nothing', count: 0 })
  })
})

describe('literal matching — empty-input guards and line cursor', () => {
  it('scan returns empty for empty content', () => {
    expect(scan('', 'q')).toEqual({ matches: [], total: 0, capped: false })
  })

  it('an empty query never compiles — it is a caller error, not a search', () => {
    expect(createScanner('', LITERAL)).toEqual({ ok: false, message: 'empty query' })
  })

  it('count returns 0 for empty content', () => {
    expect(count('', 'q')).toBe(0)
  })

  it('replace returns the input unchanged for empty content', () => {
    expect(replace('', 'q', 'X')).toEqual({ text: '', count: 0 })
  })

  it('locates a hit on a line that is not the last line', () => {
    // Exercises the `nl !== -1` branch of the post-loop line-end recomputation.
    const r = scan('hit\ntail', 'hit')
    expect(r.matches[0].line).toBe(1)
    expect(r.matches[0].excerpt).toBe('hit')
  })
})

describe('replaceOne (Replace Here)', () => {
  it('rewrites only the occurrence at the given offset', () => {
    expect(factoryOf('hit').replaceOne('a hit b hit c', 2, 'X')).toEqual({
      text: 'a X b hit c',
      count: 1,
    })
  })

  it('reports zero when the offset is not a real hit any more', () => {
    // The plan runs later than the click, so the bytes may have moved.
    expect(factoryOf('hit').replaceOne('a hit b', 3, 'X')).toEqual({ text: 'a hit b', count: 0 })
  })

  it('returns zero for empty content', () => {
    expect(factoryOf('hit').replaceOne('', 0, 'X')).toEqual({ text: '', count: 0 })
  })
})

// ─── Regex mode (ADR-0023 §13) ─────────────────────────────────────────────────────────────────

describe('regex mode (D30/D31)', () => {
  it('replaceOne reports zero for a zero-length regex hit', () => {
    // A zero-length match can never be a "here" target: there is no occurrence to point at.
    const f = factoryOf('x*', { regexp: true })
    expect(f.replaceOne('abc', 0, 'Y')).toEqual({ text: 'abc', count: 0 })
  })

  it('replaceOne and replace on an empty body in regex mode', () => {
    expect(factoryOf('a', { regexp: true }).replaceOne('', 0, 'Y')).toEqual({ text: '', count: 0 })
    expect(replace('', 'a', 'Y', { regexp: true })).toEqual({ text: '', count: 0 })
  })

  it('is opt-in: the same query is literal by default', () => {
    expect(scan('Hello', 'Hel+o').total).toBe(0)
    expect(scan('Hello', 'Hel+o', { regexp: true }).total).toBe(1)
  })

  it('is case-insensitive by default and case-sensitive with Match Case', () => {
    expect(scan('hello', 'HELLO', { regexp: true }).total).toBe(1)
    expect(scan('hello', 'HELLO', { regexp: true, matchCase: true }).total).toBe(0)
  })

  it('refuses to compile a broken pattern instead of degrading to a literal', () => {
    // D33: falling back would silently match different text.
    const compiled = createScanner('(unclosed', { ...LITERAL, regexp: true })
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.message).toMatch(/group|parenthes/i)
  })

  it('does not count zero-length matches and does not stall on them', () => {
    // `x*` matches the empty string everywhere; counting those would report hits the user cannot
    // see, and a naive `exec` loop would never advance.
    expect(scan('abc', 'x*', { regexp: true }).total).toBe(0)
    expect(scan('axxb', 'x*', { regexp: true }).total).toBe(1)
  })

  it('anchors ^ and $ to the whole document, not to lines', () => {
    expect(scan('ab\ncd', '^cd$', { regexp: true }).total).toBe(0)
    expect(scan('cd', '^cd$', { regexp: true }).total).toBe(1)
  })

  it('rejects inline modifier groups, which JS does not support', () => {
    // Locks §13.5: `(?m)` and `(?m:...)` both throw in Node, so line anchoring is not offered.
    expect(createScanner('(?m)^a', { ...LITERAL, regexp: true }).ok).toBe(false)
    expect(createScanner('(?m:^a)', { ...LITERAL, regexp: true }).ok).toBe(false)
  })

  it('expands capture groups only in regex mode (§13.8)', () => {
    expect(replace('a1 b2', '([a-z])([0-9])', '$2$1', { regexp: true })).toEqual({
      text: '1a 2b',
      count: 2,
    })
    expect(replace('a1 b2', '([a-z])([0-9])', '$&!$&', { regexp: true }).text).toBe('a1!a1 b2!b2')
    expect(replace('a1', '([a-z])', '$$', { regexp: true }).text).toBe('$1')
    // Literal mode: `$1` is written verbatim, which is the D24 invariant.
    expect(replace('a $1 b', '$1', 'X').text).toBe('a X b')
  })

  it('expands named groups, the flanking shortcuts and an unknown $ escape', () => {
    expect(
      replace('Jane Doe', '(?<first>\\w+) (?<last>\\w+)', '$<last>, $<first>', { regexp: true })
        .text,
    ).toBe('Doe, Jane')
    expect(replace('abc', 'b', '<$&>', { regexp: true }).text).toBe('a<b>c')
    expect(replace('abc', 'b', '<$`>', { regexp: true }).text).toBe('a<a>c')
    expect(replace('abc', 'b', "<$'>", { regexp: true }).text).toBe('a<c>c')
    expect(replace('abc', 'b', '$z', { regexp: true }).text).toBe('a$zc')
    // `$<` with no closing `>` is left alone rather than swallowed.
    expect(replace('abc', 'b', '$<oops', { regexp: true }).text).toBe('a$<oopsc')
    // A named group the pattern does not declare expands to nothing.
    expect(replace('abc', 'b', '$<nope>', { regexp: true }).text).toBe('ac')
    // So does a numbered group that does not exist.
    expect(replace('abc', 'b', '$1', { regexp: true }).text).toBe('ac')
  })

  it('reports lineSpan for a match that crosses lines', () => {
    const r = scan('one\ntwo\nthree', 'two\nthree', { regexp: true })
    expect(r.matches[0]).toMatchObject({ line: 2, lineSpan: 2 })
  })

  it('capped / total behave exactly as in literal mode', () => {
    const body = Array.from({ length: 60 }, () => 'ab').join(' ')
    const r = scan(body, '[ab]+', { regexp: true })
    expect(r.matches).toHaveLength(50)
    expect(r.capped).toBe(true)
    expect(r.total).toBe(60)
  })

  it('handles empty content', () => {
    expect(scan('', 'a', { regexp: true })).toEqual({ matches: [], total: 0, capped: false })
    expect(count('', 'a', { regexp: true })).toBe(0)
    expect(replace('', 'a', 'X', { regexp: true })).toEqual({ text: '', count: 0 })
  })

  it('replaceOne expands groups for the single chosen hit', () => {
    const f = factoryOf('([a-z])([0-9])', { regexp: true })
    expect(f.replaceOne('a1 b2', 0, '$2$1')).toEqual({ text: '1a b2', count: 1 })
    expect(f.replaceOne('a1 b2', 1, '$2$1')).toEqual({ text: 'a1 b2', count: 0 })
    expect(f.replaceOne('', 0, 'X')).toEqual({ text: '', count: 0 })
  })
})

it('replaceOne falls through when whole word rejects the offset', () => {
  // The whole-word filter discards the candidate, so `box.raw` stays null and the offset check
  // never has anything to match — the branch where `raw.start !== start` short-circuits.
  const f = factoryOf('Ell', { wholeWord: true })
  expect(f.replaceOne('Hello', 1, 'Y')).toEqual({ text: 'Hello', count: 0 })
})

it('counts zero-length matches as nothing, so a regex replace has nothing to expand', () => {
  // Exercises the `count === 0` early return in regex mode's replace.
  expect(replace('abc', 'x*', 'Y', { regexp: true })).toEqual({ text: 'abc', count: 0 })
})

it('honours whole word in literal mode too', () => {
  // The whole-word filter is shared by both modes; this pins the literal branch of it.
  expect(scan('Hello World', 'Hello', { wholeWord: true }).total).toBe(1)
  expect(scan('HelloWorld', 'Hello', { wholeWord: true }).total).toBe(0)
})

it('honours whole word in literal replace', () => {
  expect(replace('Hello World', 'Hello', 'Y', { wholeWord: true })).toEqual({
    text: 'Y World',
    count: 1,
  })
  expect(replace('HelloWorld', 'Hello', 'Y', { wholeWord: true })).toEqual({
    text: 'HelloWorld',
    count: 0,
  })
})

it('caps the display list but keeps counting when whole word is on', () => {
  const body = Array.from({ length: 60 }, () => 'ab').join(' ')
  const r = scan(body, 'ab', { wholeWord: true })
  expect(r.matches).toHaveLength(50)
  expect(r.capped).toBe(true)
  expect(r.total).toBe(60)
})

it('carries the message of a non-Error throw', () => {
  // `new RegExp` normally throws an Error, but a hostile realm can throw anything; the message
  // must still be a string so the diagnostic can carry it. Faked by making the constructor
  // throw a non-Error.
  const RealRegExp = RegExp
  class FakeRegExp {
    constructor() {
      throw 'not an Error'
    }
  }
  globalThis.RegExp = FakeRegExp as unknown as typeof RegExp
  try {
    const compiled = createScanner('x', { ...LITERAL, regexp: true })
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.message).toBe('not an Error')
  } finally {
    globalThis.RegExp = RealRegExp
  }
})

// ─── expandNewlineEscapes (D32/D36) ────────────────────────────────────────────────────────────

describe('expandNewlineEscapes (D32/D36)', () => {
  it('rewrites the literal two-character \\n outside a character class', () => {
    expect(expandNewlineEscapes('a\\nb')).toBe('a(?:\\r\\n|\\r|\\n)b')
  })

  it('leaves an escaped backslash alone, so \\\\n is not a newline', () => {
    expect(expandNewlineEscapes('a\\\\nb')).toBe('a\\\\nb')
  })

  it('leaves \\r and other escapes untouched', () => {
    expect(expandNewlineEscapes('\\r\\d')).toBe('\\r\\d')
  })

  it('does not rewrite inside a character class, where the alternation would be invalid', () => {
    expect(expandNewlineEscapes('[\\n]')).toBe('[\\n]')
  })

  it('tracks the class correctly across a closing bracket', () => {
    expect(expandNewlineEscapes('[a]\\nb')).toBe('[a](?:\\r\\n|\\r|\\n)b')
  })

  it('matches across CRLF and returns ORIGINAL offsets (D36)', () => {
    // The haystack is never normalised: normalising would shift every offset after the first line.
    const body = 'a\r\nb'
    const r = scan(body, 'a\\nb', { regexp: true })
    expect(r.total).toBe(1)
    expect(r.matches[0].start).toBe(0)
    expect(r.matches[0].end).toBe(4)
    expect(r.matches[0].lineSpan).toBe(2)
  })

  it('matches an LF-only and a CR-only document with the same pattern', () => {
    expect(count('a\nb', 'a\\nb', { regexp: true })).toBe(1)
    expect(count('a\rb', 'a\\nb', { regexp: true })).toBe(1)
  })

  it('treats \\n as two ordinary characters in literal mode (D32)', () => {
    // The literal-phrase invariant must not be broken: only regex mode expands the escape.
    expect(scan('a\\nb', 'a\\nb').total).toBe(1)
    expect(scan('a\nb', 'a\\nb').total).toBe(0)
  })
})

// ─── Whole word (D34/D35) ──────────────────────────────────────────────────────────────────────

describe('whole word (D34/D35)', () => {
  it('matches a Latin word but not a substring of one', () => {
    expect(count('Hello World', 'Hello', { wholeWord: true })).toBe(1)
    expect(count('HelloWorld', 'Hello', { wholeWord: true })).toBe(0)
    expect(count('Hello World', 'Hello')).toBe(1)
    expect(count('HelloWorld', 'Hello')).toBe(1)
  })

  it('rejects when only one end is on a boundary', () => {
    expect(count('Hello', 'Ell', { wholeWord: true })).toBe(0)
  })

  it('works for Chinese — ICU has a Han dictionary, so this is not a no-op', () => {
    expect(count('这是中文文本', '中文', { wholeWord: true })).toBe(1)
    expect(count('这是中文文本', '文本', { wholeWord: true })).toBe(1)
    // Straddles the 中文 / 文本 boundary.
    expect(count('这是中文文本', '文文', { wholeWord: true })).toBe(0)
  })

  it('works for Japanese', () => {
    expect(count('食べることが', '食べる', { wholeWord: true })).toBe(1)
    expect(count('食べることが', 'べるこ', { wholeWord: true })).toBe(0)
  })

  it('applies in regex mode too', () => {
    expect(count('HelloWorld Hello', 'Hell\\w', { regexp: true, wholeWord: true })).toBe(1)
    expect(count('HelloWorld Hello', 'Hell\\w', { regexp: true })).toBe(2)
  })

  it('replaces in regex mode with whole word on', () => {
    // The whole-word filter is shared by the replace path too — otherwise "Replace All" could
    // rewrite text the display never offered.
    expect(replace('HelloWorld Hello', 'Hell\\w', 'Y', { regexp: true, wholeWord: true })).toEqual({
      text: 'HelloWorld Y',
      count: 1,
    })
  })

  it('does not treat an apostrophe as a boundary', () => {
    // "don't" is ONE UAX #29 segment, so `t` is not a whole word inside it — the reason the fast
    // path only ever rejects and never accepts.
    expect(count("don't stop", 't', { wholeWord: true })).toBe(0)
  })

  it('treats a match that runs to the end of the text as a whole word', () => {
    expect(count('say hello', 'hello', { wholeWord: true })).toBe(1)
  })
})

// ─── Compile-once (§13.5) ──────────────────────────────────────────────────────────────────────

describe('regex compilation', () => {
  it('compiles the query once per scan, not once per document', () => {
    // A catastrophic-backtracking pattern must not pay compilation cost per document, and the
    // Worker timeout budget (D37) assumes one compile per query.
    const RealRegExp = RegExp
    const compiled: string[] = []
    class TrackingRegExp extends RealRegExp {
      constructor(pattern: string | RegExp, flags?: string) {
        super(pattern as RegExp, flags)
        if (typeof pattern === 'string') compiled.push(pattern)
      }
    }
    globalThis.RegExp = TrackingRegExp as unknown as typeof RegExp
    try {
      const scanner = createScanner('Hel+o', { ...LITERAL, regexp: true })
      expect(scanner.ok).toBe(true)
      expect(compiled.filter((p) => p === 'Hel+o')).toHaveLength(1)
      if (!scanner.ok) return
      // Matching more documents must reuse the compiled regex, not rebuild it.
      for (const text of ['Hello one', 'Hello two', 'Hello three']) {
        scanner.factory.count(text)
      }
      expect(compiled.filter((p) => p === 'Hel+o')).toHaveLength(1)
    } finally {
      globalThis.RegExp = RealRegExp
    }
  })
})
