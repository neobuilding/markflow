// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parsePatternList, splitGlobAware, matchPattern } from './patterns'

describe('splitGlobAware (ADR-0023)', () => {
  it('splits on ordinary commas', () => {
    expect(splitGlobAware('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('keeps a comma inside a brace expansion', () => {
    expect(splitGlobAware('{a,b}.md, c.md')).toEqual(['{a,b}.md', ' c.md'])
  })

  it('keeps a comma inside a character class', () => {
    // `input.split(',')` would break this into `[ab` and `c].md` — both invalid.
    expect(splitGlobAware('[ab,c].md')).toEqual(['[ab,c].md'])
  })

  it('keeps a comma preceded by a backslash', () => {
    expect(splitGlobAware('a\\,b')).toEqual(['a\\,b'])
  })

  it('ignores a trailing comma', () => {
    expect(parsePatternList('a.md,').patterns).toHaveLength(1)
  })
})

describe('parsePatternList — validation (ADR-0023)', () => {
  it('accepts a valid glob', () => {
    const r = parsePatternList('**/*.md')
    expect(r.errors).toEqual([])
    expect(r.patterns).toHaveLength(1)
  })

  it('rejects an unclosed character class', () => {
    // With picomatch's DEFAULT options this silently never matches; `strictBrackets` makes it
    // throw — which is why the option is mandatory here.
    const r = parsePatternList('a[bc')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].raw).toBe('a[bc')
  })

  it('rejects an unclosed brace', () => {
    expect(parsePatternList('{a,b').errors).toHaveLength(1)
  })

  it('rejects a stray closing brace — which picomatch itself accepts', () => {
    // Verified against the resolved picomatch: `**/*.md}` parses cleanly even WITH
    // strictBrackets, so the brace-balance check has to be ours.
    expect(parsePatternList('**/*.md}').errors).toHaveLength(1)
  })

  it('rejects a path that escapes the root', () => {
    const r = parsePatternList('../outside', '/ws')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toMatch(/outside/)
  })

  it('treats empty input as "no restriction" without error', () => {
    expect(parsePatternList('   ')).toEqual({ patterns: [], errors: [] })
  })
})

describe('parsePatternList — expansion (ADR-0023)', () => {
  it('expands a path pattern to itself and its subtree', () => {
    const r = parsePatternList('./work', '/ws')
    expect(r.patterns[0]).toMatchObject({ raw: './work', isPath: true })
    expect(r.patterns[0].candidates).toEqual(['work', 'work/**'])
  })

  it('expands a glob to any depth, and to its subtree', () => {
    const r = parsePatternList('docs', '/ws')
    expect(r.patterns[0].isPath).toBe(false)
    expect(r.patterns[0].candidates).toEqual(['**/docs', '**/docs/**'])
  })

  it('resolves an absolute path against the root', () => {
    const r = parsePatternList('/ws/docs', '/ws')
    expect(r.patterns[0].candidates).toEqual(['docs', 'docs/**'])
  })

  it('rejects an absolute path when there is no root to resolve against', () => {
    expect(parsePatternList('/ws/docs', null).errors).toHaveLength(1)
  })
})

describe('matchPattern', () => {
  function matches(pattern: string, rel: string, root = '/ws'): boolean {
    const r = parsePatternList(pattern, root)
    return matchPattern(rel, r.patterns[0])
  }

  it('anchors a path pattern: ./work hits work/** but not a/work/**', () => {
    expect(matches('./work', 'work/w.md')).toBe(true)
    expect(matches('./work', 'a/work/w.md')).toBe(false)
  })

  it('hits a bare name at any depth', () => {
    expect(matches('work', 'work/w.md')).toBe(true)
    expect(matches('work', 'a/work/w.md')).toBe(true)
  })

  it('hits nested files for *.md — it is NOT blindly suffixed with /**', () => {
    expect(matches('*.md', 'a.md')).toBe(true)
    expect(matches('*.md', 'a/b.md')).toBe(true)
  })

  it('matches case-insensitively on every platform', () => {
    // MarkFlow's deliberate unified rule for PATH globs (D16): `nocase: true` unconditionally, so
    // Windows and Linux CI cannot disagree about which files are in scope. (VS Code derives this
    // from the platform; we do not.)
    expect(matches('Docs', 'docs/a.md')).toBe(true)
    expect(matches('**/Docs/**', 'docs/a.md')).toBe(true)
  })
})

describe('parsePatternList — edge cases', () => {
  it('rejects a stray closing brace (negative depth)', () => {
    expect(parsePatternList('a}b', '/ws').errors[0]?.message).toMatch(/unbalanced/)
  })

  it('accepts a balanced brace group (the non-negative depth branch)', () => {
    const r = parsePatternList('{a,b}.md', '/ws')
    expect(r.errors).toHaveLength(0)
    expect(r.patterns).toHaveLength(1)
  })

  it('rejects an absolute path equal to the root, and one outside it', () => {
    expect(parsePatternList('/ws', '/ws').errors[0]?.message).toMatch(/outside/)
    expect(parsePatternList('/other/x', '/ws').errors[0]?.message).toMatch(/outside/)
  })

  it('treats a lone slash as no pattern and no error (nothing after stripping)', () => {
    const r = parsePatternList('/', '/ws')
    expect(r.patterns).toHaveLength(0)
    expect(r.errors).toHaveLength(0)
  })

  it('rejects a path pattern whose glob is malformed', () => {
    // Path-type branch (isPath true) that still fails picomatch validation.
    expect(parsePatternList('./a[bc', '/ws').errors.length).toBeGreaterThan(0)
  })
})
