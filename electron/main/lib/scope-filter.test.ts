// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { buildScope, inScope, relToRoot, scopeDiagnostics } from './scope-filter'
import { createMemoryDiskIO, type DiskIO } from './disk-io'
import { mkTestDir } from '../test-support/tmp'

let io: DiskIO
let root: string

beforeEach(() => {
  io = createMemoryDiskIO()
  root = mkTestDir('scope-')
})

describe('buildScope (ADR-0023)', () => {
  it('returns an unrestricted scope for empty input', () => {
    const r = buildScope('', '', root, io)
    expect(r.blocking).toBe(false)
    expect(r.scope.include).toEqual([])
    expect(r.scope.exclude).toEqual([])
  })

  it('blocks the query on an invalid include and names the field', () => {
    const r = buildScope('a[bc', '', root, io)
    expect(r.blocking).toBe(true)
    expect(r.diagnostics[0]).toMatchObject({
      code: 'invalid-pattern',
      field: 'include',
      pattern: 'a[bc',
      blocking: true,
    })
    // Fail-closed: an unparseable pattern is never dropped, because dropping a narrowing
    // condition silently WIDENS the scope.
    expect(r.scope.include).toEqual([])
  })

  it('blocks the query on an invalid exclude', () => {
    const r = buildScope('', '**/*.md}', root, io)
    expect(r.blocking).toBe(true)
    expect(r.diagnostics[0]).toMatchObject({ code: 'invalid-pattern', field: 'exclude' })
  })

  it('blocks when a scope is set but there is no root', () => {
    const r = buildScope('./docs', '', null, io)
    expect(r.blocking).toBe(true)
    expect(r.diagnostics[0]).toMatchObject({ code: 'no-workspace-root', blocking: true })
  })

  // An empty scope with no root is the "search in-memory drafts" case — not an error.
  it('does NOT block an empty scope with no root', () => {
    expect(buildScope('', '', null, io).blocking).toBe(false)
  })

  it('reports a path that does not exist instead of searching the whole root', () => {
    const r = buildScope('./nope', '', root, io)
    expect(r.blocking).toBe(true)
    expect(r.diagnostics[0]).toMatchObject({
      code: 'path-not-found',
      field: 'include',
      blocking: true,
    })
  })

  // A missing INCLUDE path is a narrowing condition that silently vanished — fail-closed (D27).
  it('blocks on a missing INCLUDE path, correctly labelled as include', () => {
    io.mkdir(join(root, 'docs'), { recursive: true })
    const r = buildScope('./nope', './docs', root, io)
    expect(r.blocking).toBe(true)
    expect(r.diagnostics[0]).toMatchObject({
      code: 'path-not-found',
      field: 'include',
      pattern: './nope',
      blocking: true,
    })
  })

  // A missing EXCLUDE path is harmless (excluding nothing changes no result): surface it as a
  // non-blocking diagnostic and keep searching — a typo in the exclude box must not block the query
  // or be mislabelled as an include problem.
  it('surfaces a non-blocking diagnostic (and does not block) on a missing EXCLUDE path', () => {
    io.mkdir(join(root, 'docs'), { recursive: true })
    const r = buildScope('./docs', './nope', root, io)
    expect(r.blocking).toBe(false)
    const d = r.diagnostics.find((x) => x.code === 'path-not-found')
    expect(d).toMatchObject({ field: 'exclude', pattern: './nope', blocking: false })
    // The valid include still applies (as parsed patterns: `.raw` is the user-entered string).
    expect(r.scope.include.map((p: { raw: string }) => p.raw)).toEqual(['./docs'])
  })

  it('accepts a path that does exist', () => {
    io.mkdir(join(root, 'docs'), { recursive: true })
    expect(buildScope('./docs', '', root, io).blocking).toBe(false)
  })

  // A glob that matches nothing is simply "no results" — not an error.
  it('does not report path-not-found for a glob', () => {
    expect(buildScope('nothing-matches-this', '', root, io).blocking).toBe(false)
  })
})

describe('inScope (ADR-0023)', () => {
  const scopeOf = (include: string, exclude: string, r: string | null = root) =>
    buildScope(include, exclude, r, io).scope

  it('includes everything when both fields are empty', () => {
    const s = scopeOf('', '')
    expect(inScope('a.md', s)).toBe(true)
    expect(inScope(null, s)).toBe(true)
  })

  it('excludes drafts as soon as EITHER field is non-empty', () => {
    expect(inScope(null, scopeOf('**/*.md', ''))).toBe(false)
    expect(inScope(null, scopeOf('', 'nothing'))).toBe(false)
  })

  it('anchors ./work but matches a bare work at any depth', () => {
    // `path-not-found` is checked against the filesystem, so the directories must exist for the
    // scope to be usable at all.
    io.mkdir(join(root, 'work'), { recursive: true })
    io.mkdir(join(root, 'a', 'work'), { recursive: true })
    expect(inScope('work/w.md', scopeOf('./work', ''))).toBe(true)
    expect(inScope('a/work/w.md', scopeOf('./work', ''))).toBe(false)
    expect(inScope('a/work/w.md', scopeOf('work', ''))).toBe(true)
  })

  it('lets exclude win over include', () => {
    const s = scopeOf('**/*.md', './archive/**')
    expect(inScope('a.md', s)).toBe(true)
    expect(inScope('archive/a.md', s)).toBe(false)
  })
})

describe('relToRoot', () => {
  it('returns null without a root', () => {
    expect(relToRoot('/ws/a.md', null)).toBeNull()
  })

  it('returns null for a file outside the root', () => {
    expect(relToRoot('/elsewhere/a.md', root)).toBeNull()
  })

  it('returns the relative path for a file inside the root', () => {
    expect(relToRoot(join(root, 'sub', 'a.md'), root)).toBe('sub/a.md')
  })
})

describe('scopeDiagnostics', () => {
  it('explains that drafts were excluded', () => {
    const d = scopeDiagnostics(buildScope('**/*.md', '', root, io).scope, 3, 0)
    expect(d.some((x) => x.code === 'drafts-excluded')).toBe(true)
  })

  it('stays silent about drafts when no scope is set', () => {
    expect(scopeDiagnostics(buildScope('', '', root, io).scope, 3, 0)).toEqual([])
  })

  it('reports documents skipped for sitting outside the root', () => {
    const d = scopeDiagnostics(buildScope('', '', root, io).scope, 0, 2)
    expect(d[0]).toMatchObject({ code: 'out-of-root-skipped', blocking: false })
  })
})
