// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { MD_EXTS, isMarkdownFile, stripMarkdownExt } from './markdown-ext'

describe('markdown-ext — supported extensions', () => {
  it('covers every extension the app can open', () => {
    expect([...MD_EXTS].sort()).toEqual(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'].sort())
  })
})

describe('markdown-ext — isMarkdownFile', () => {
  it('accepts every supported extension', () => {
    for (const ext of MD_EXTS) {
      expect(isMarkdownFile(`/notes/doc${ext}`)).toBe(true)
    }
  })

  it('accepts an extension in any letter case', () => {
    expect(isMarkdownFile('/notes/README.MD')).toBe(true)
    expect(isMarkdownFile('/notes/Comp.Mdx')).toBe(true)
    expect(isMarkdownFile('/notes/A.MARKDOWN')).toBe(true)
  })

  it('rejects non-Markdown extensions', () => {
    expect(isMarkdownFile('/notes/a.txt')).toBe(false)
    // The export artefacts the app itself writes must never be watched.
    expect(isMarkdownFile('/notes/a.html')).toBe(false)
    expect(isMarkdownFile('/notes/a.pdf')).toBe(false)
    expect(isMarkdownFile('/notes/a.docx')).toBe(false)
  })

  it('rejects a near-miss that merely ends with an extension name', () => {
    expect(isMarkdownFile('/notes/notmd')).toBe(false)
    expect(isMarkdownFile('/notes/a.mdx.txt')).toBe(false)
    expect(isMarkdownFile('/notes/a.md.bak')).toBe(false)
  })

  it('rejects a path with no extension at all', () => {
    expect(isMarkdownFile('/notes/README')).toBe(false)
  })

  it('judges a hidden file by its real extension, not by its leading dot', () => {
    // `extname` treats a leading dot as part of the name, so these are not Markdown.
    expect(isMarkdownFile('/notes/.md')).toBe(false)
    expect(isMarkdownFile('/notes/.gitignore')).toBe(false)
  })
})

describe('markdown-ext — stripMarkdownExt', () => {
  it('drops the extension to derive a title', () => {
    for (const ext of MD_EXTS) {
      expect(stripMarkdownExt(`doc${ext}`)).toBe('doc')
    }
  })

  it('is case-insensitive about the extension being stripped', () => {
    expect(stripMarkdownExt('README.MD')).toBe('README')
    expect(stripMarkdownExt('Comp.Mdx')).toBe('Comp')
  })

  it('leaves a non-Markdown name untouched', () => {
    expect(stripMarkdownExt('notes.txt')).toBe('notes.txt')
    expect(stripMarkdownExt('Makefile')).toBe('Makefile')
  })

  it('only strips a trailing extension, never an interior one', () => {
    expect(stripMarkdownExt('a.md.txt')).toBe('a.md.txt')
    expect(stripMarkdownExt('a.md.bak')).toBe('a.md.bak')
  })

  it('keeps dots that are part of the title', () => {
    expect(stripMarkdownExt('v1.2.release.md')).toBe('v1.2.release')
  })

  it('leaves a dotted name with no real extension alone', () => {
    // Unlike a trailing regex match, a name that is *only* an extension keeps its
    // text — collapsing it to '' would produce a blank document title.
    expect(stripMarkdownExt('.md')).toBe('.md')
  })
})
