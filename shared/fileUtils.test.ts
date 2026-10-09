// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { arePathsSame, foldName, relativePath } from './fileUtils'

// `shared/fileUtils.ts` is a pure rule module: no `process`, no `navigator`,
// no globals. Every branch is therefore reachable with explicit arguments and covered
// deterministically on any runner — no OS faking required.
describe('shared/fileUtils — case-sensitivity rules', () => {
  describe('arePathsSame', () => {
    it('treats identical paths as the same on any filesystem', () => {
      expect(arePathsSame('a.md', 'a.md', true)).toBe(true)
      expect(arePathsSame('a.md', 'a.md', false)).toBe(true)
    })

    it('treats a case-only difference as the same on a case-insensitive filesystem', () => {
      expect(arePathsSame('a.md', 'A.md', false)).toBe(true)
    })

    it('treats a case-only difference as different on a case-sensitive filesystem', () => {
      expect(arePathsSame('a.md', 'A.md', true)).toBe(false)
    })

    it('treats a genuinely different name as different on any filesystem', () => {
      expect(arePathsSame('a.md', 'b.md', false)).toBe(false)
      expect(arePathsSame('a.md', 'b.md', true)).toBe(false)
    })
  })

  describe('foldName', () => {
    it('leaves the name untouched on a case-sensitive filesystem', () => {
      expect(foldName('Note.md', true)).toBe('Note.md')
    })

    it('lowercases the name on a case-insensitive filesystem', () => {
      expect(foldName('Note.md', false)).toBe('note.md')
    })
  })

  describe('relativePath', () => {
    it('returns the path itself when there is no scope folder', () => {
      expect(relativePath('/abs/work/notes.md')).toBe('/abs/work/notes.md')
      expect(relativePath('/abs/work/notes.md', null)).toBe('/abs/work/notes.md')
      expect(relativePath('/abs/work/notes.md', '')).toBe('/abs/work/notes.md')
    })

    it('strips the scope folder prefix, normalizing backslashes to forward slashes', () => {
      expect(relativePath('/abs/work/2026/notes.md', '/abs/work')).toBe('2026/notes.md')
      expect(relativePath('D:\\work\\sub\\notes.md', 'D:\\work')).toBe('sub/notes.md')
    })

    it('ignores a trailing separator on the scope folder', () => {
      expect(relativePath('/abs/work/notes.md', '/abs/work/')).toBe('notes.md')
    })

    it('matches the scope folder case-insensitively (Windows)', () => {
      expect(relativePath('/ABS/Work/notes.md', '/abs/work')).toBe('notes.md')
    })

    it('returns the path unchanged when the file lies outside the scope folder', () => {
      expect(relativePath('/other/place/notes.md', '/abs/work')).toBe('/other/place/notes.md')
    })

    it('does not confuse a sibling folder that merely shares a prefix', () => {
      // '/abs/workshop' starts with '/abs/work' but is a different folder.
      expect(relativePath('/abs/workshop/notes.md', '/abs/work')).toBe('/abs/workshop/notes.md')
    })

    it('treats a root-only scope folder as having no root', () => {
      // Without this guard a '/' scope would strip the leading separator instead.
      expect(relativePath('/abs/work/notes.md', '/')).toBe('/abs/work/notes.md')
      expect(relativePath('D:\\notes.md', '\\')).toBe('D:/notes.md')
    })
  })
})
