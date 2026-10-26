import { describe, it, expect } from 'vitest'
import { hasGlobMeta, globMatch } from './glob'
import { relativePath } from '../../../shared/fileUtils'
import { buildScope, inScope } from '../lib/scope-filter'
import { createMemoryDiskIO } from '../lib/disk-io'

describe('hasGlobMeta', () => {
  it('detects glob metacharacters', () => {
    expect(hasGlobMeta('*.md')).toBe(true)
    expect(hasGlobMeta('src/**/*.ts')).toBe(true)
    expect(hasGlobMeta('note[1-3].txt')).toBe(true)
    expect(hasGlobMeta('{a,b}.md')).toBe(true)
    expect(hasGlobMeta('foo?')).toBe(true)
  })

  it('returns false for plain text', () => {
    expect(hasGlobMeta('report')).toBe(false)
    expect(hasGlobMeta('my notes')).toBe(false)
  })

  it('does not treat a lone closing bracket/brace as glob syntax (Q15)', () => {
    // Only `* ? [ {` trigger glob mode; `]` and `}` alone are ordinary characters.
    expect(hasGlobMeta('note]')).toBe(false)
    expect(hasGlobMeta('a}')).toBe(false)
  })
})

describe('globMatch', () => {
  it('matches the file name at any depth with * (Q8: matchBase)', () => {
    expect(globMatch('meeting.md', '*.md')).toBe(true)
    // A pattern without a slash matches the basename regardless of directory depth.
    expect(globMatch('sub/meeting.md', '*.md')).toBe(true)
    expect(globMatch('a/b/c/meeting.md', '*.md')).toBe(true)
  })

  it('matches case-insensitively even with literal letters in the pattern (Q15)', () => {
    expect(globMatch('Report.md', 'report*')).toBe(true)
    expect(globMatch('NOTES.md', 'notes*')).toBe(true)
  })

  it('does not use basename for patterns that contain a slash', () => {
    // `notes/*` has a slash, so it matches the path relative to the active folder.
    expect(globMatch('notes/meeting.md', 'notes/*')).toBe(true)
    expect(globMatch('other/meeting.md', 'notes/*')).toBe(false)
    // `*.md` (no slash) still matches here because basename kicks in.
    expect(globMatch('other/meeting.md', '*.md')).toBe(true)
  })

  it('crosses directories with **', () => {
    expect(globMatch('work/2026/notes/meeting.md', '**/*.md')).toBe(true)
    expect(globMatch('work/2026/notes/meeting.md', '**/notes/*.md')).toBe(true)
  })

  it('matches character ranges and braces', () => {
    expect(globMatch('note1.md', 'note[1-3].md')).toBe(true)
    expect(globMatch('note9.md', 'note[1-3].md')).toBe(false)
    expect(globMatch('a.md', '{a,b}.md')).toBe(true)
    expect(globMatch('c.md', '{a,b}.md')).toBe(false)
  })

  it('returns false on invalid patterns instead of throwing', () => {
    expect(globMatch('x.md', '[')).toBe(false)
  })
})

describe('relativePath', () => {
  it('returns the path unchanged when no folder is active', () => {
    expect(relativePath('/abs/work/notes.md')).toBe('/abs/work/notes.md')
  })

  it('computes a forward-slash relative path from the scope folder', () => {
    expect(relativePath('/abs/work/2026/notes.md', '/abs/work')).toBe('2026/notes.md')
    expect(relativePath('/abs/work/2026/notes.md', '/abs/work/2026')).toBe('notes.md')
  })
})

// D26: include/exclude must NOT reuse the filename-mode matchBase. The same string means
// "path prefix" in a scope but "file name" in Quick Open; if the two ever converge, the scope
// has silently become a name filter.
describe('scope vs Quick Open matching (D26)', () => {
  it('treats a bare folder name as a path prefix, not a file name', () => {
    const built = buildScope('docs', undefined, '/ws', createMemoryDiskIO())
    expect(built.blocking).toBe(false)
    if (built.blocking) return
    // Scope semantics: `docs` matches files UNDER a docs directory at any depth.
    expect(inScope('a/docs/readme.md', built.scope)).toBe(true)
    // Quick Open semantics: the same query matches a document NAMED docs — never a path.
    expect(globMatch('a/docs/readme.md', 'docs')).toBe(false)
    expect(globMatch('docs', 'docs')).toBe(true)
  })
})
