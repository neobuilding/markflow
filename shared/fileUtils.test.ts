// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { arePathsSame, foldName } from './fileUtils'

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
})
