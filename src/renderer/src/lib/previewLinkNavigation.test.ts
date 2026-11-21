import { describe, it, expect, vi } from 'vitest'
import {
  followPreviewLink,
  resolvePreviewLink,
  sameFilePath,
  type FollowLinkDeps,
} from './previewLinkNavigation'

describe('resolvePreviewLink', () => {
  it('ignores malformed percent escapes instead of throwing', () => {
    expect(resolvePreviewLink('#%E0%A4%A', '/n/index.md')).toEqual({
      kind: 'anchor',
      id: '%E0%A4%A',
    })
    expect(resolvePreviewLink('C:%E0%A4%A/x.md', null)).toEqual({ kind: 'ignored' })
  })

  it('ignores file URLs with a host and malformed file/URL inputs', () => {
    expect(resolvePreviewLink('file://host/a.md', '/n/index.md')).toEqual({ kind: 'ignored' })
    expect(resolvePreviewLink('file://%E0%A4%A/a.md', '/n/index.md')).toEqual({
      kind: 'ignored',
    })
    expect(resolvePreviewLink('/docs/a.md', '/n/index.md')).toEqual({ kind: 'ignored' })
    expect(resolvePreviewLink('file:///C:/a.md', '/n/index.md', '/')).toEqual({
      kind: 'document',
      path: 'C:/a.md',
    })
  })

  it('uses the workspace root as a directory base and tolerates URL parser failures', () => {
    expect(resolvePreviewLink('/docs/a.md', 'C:/n/index.md', 'C:/root')).toEqual({
      kind: 'document',
      path: 'C:/root/docs/a.md',
    })
    expect(resolvePreviewLink('/docs/a.md', '/n/index.md', '/root')).toEqual({
      kind: 'document',
      path: '/root/docs/a.md',
    })
    expect(resolvePreviewLink('target.md', '/n/index.md')).toEqual({
      kind: 'document',
      path: '/n/target.md',
    })
    expect(resolvePreviewLink('%E0%A4%A.md', '/n/index.md')).toEqual({
      kind: 'document',
      path: '/n/%E0%A4%A.md',
    })
  })

  it('resolves a relative markdown link against the document directory (Windows)', () => {
    expect(resolvePreviewLink('target.md', 'C:\\notes\\index.md')).toEqual({
      kind: 'document',
      path: 'C:/notes/target.md',
    })
  })

  it('resolves a relative markdown link against the document directory (POSIX)', () => {
    expect(resolvePreviewLink('sub/target.md', '/home/me/notes/index.md')).toEqual({
      kind: 'document',
      path: '/home/me/notes/sub/target.md',
    })
  })

  it('resolves against a relative document path without a drive or leading slash', () => {
    expect(resolvePreviewLink('target.md', 'notes/index.md')).toEqual({
      kind: 'document',
      path: '/notes/target.md',
    })
  })

  it('normalises ../ segments and ignores query/fragment suffixes', () => {
    expect(resolvePreviewLink('../other/target.md?raw=1#head', 'C:\\notes\\a\\index.md')).toEqual({
      kind: 'document',
      path: 'C:/notes/other/target.md',
    })
  })

  it('decodes percent escapes in the path', () => {
    expect(resolvePreviewLink('my%20notes.md', '/n/index.md')).toEqual({
      kind: 'document',
      path: '/n/my notes.md',
    })
  })

  it('resolves mdx files as documents', () => {
    expect(resolvePreviewLink('a.mdx', '/n/index.md')).toEqual({
      kind: 'document',
      path: '/n/a.mdx',
    })
  })

  it('sends non-markdown relative files to the OS as native paths', () => {
    expect(resolvePreviewLink('photo.png', '/n/index.md')).toEqual({
      kind: 'localFile',
      path: '/n/photo.png',
    })
  })

  it('treats Windows drive paths as absolute local paths, not unknown URL schemes', () => {
    expect(resolvePreviewLink('C:\\assets\\photo.png', '/n/index.md')).toEqual({
      kind: 'localFile',
      path: 'C:/assets/photo.png',
    })
    expect(resolvePreviewLink('D:/docs/a.md', null)).toEqual({
      kind: 'document',
      path: 'D:/docs/a.md',
    })
  })

  it('accepts percent-escaped drive paths as they reach the DOM from markdown-it', () => {
    // markdown-it emits `C:%5Cdir%5Cfile.md` for a backslash path; the raw href is what the
    // preview click handler reads, so this form must resolve like the unescaped one.
    expect(resolvePreviewLink('C:%5Cassets%5Cphoto.png', '/n/index.md')).toEqual({
      kind: 'localFile',
      path: 'C:/assets/photo.png',
    })
    expect(resolvePreviewLink('D:%5Cdocs%5Ca.md', null)).toEqual({
      kind: 'document',
      path: 'D:/docs/a.md',
    })
  })

  it('resolves a leading / against the workspace root, not the drive root (ADR-0038 §3.1.2)', () => {
    expect(resolvePreviewLink('/shared/a.md', 'C:\\ws\\sub\\index.md', 'C:\\ws')).toEqual({
      kind: 'document',
      path: 'C:/ws/shared/a.md',
    })
    expect(
      resolvePreviewLink('/assets/logo.svg', '/home/me/ws/sub/index.md', '/home/me/ws'),
    ).toEqual({
      kind: 'localFile',
      path: '/home/me/ws/assets/logo.svg',
    })
  })

  it('ignores leading-/ links when there is no workspace root', () => {
    expect(resolvePreviewLink('/shared/a.md', '/ws/sub/index.md', null)).toEqual({
      kind: 'ignored',
    })
  })

  it('keeps http(s), mailto and tel links external', () => {
    for (const url of [
      'https://example.com/a',
      'http://example.com/a',
      'mailto:a@example.com',
      'tel:+123',
    ]) {
      expect(resolvePreviewLink(url, '/n/index.md')).toEqual({ kind: 'external', url })
    }
  })

  it('treats protocol-relative URLs as external web links', () => {
    expect(resolvePreviewLink('//example.com/a', '/n/index.md')).toEqual({
      kind: 'external',
      url: 'https://example.com/a',
    })
  })

  it('turns a fragment-only href into an in-preview anchor', () => {
    expect(resolvePreviewLink('#my%20heading', '/n/index.md')).toEqual({
      kind: 'anchor',
      id: 'my heading',
    })
  })

  it('resolves file: URLs by extension: markdown is a document, anything else is local', () => {
    expect(resolvePreviewLink('file:///C:/notes/a.md', null)).toEqual({
      kind: 'document',
      path: 'C:/notes/a.md',
    })
    expect(resolvePreviewLink('file:///C:/notes/a.png', null)).toEqual({
      kind: 'localFile',
      path: 'C:/notes/a.png',
    })
  })

  it('ignores dangerous or unknown schemes so they cannot navigate the shell', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'appdoc://d/a.png',
      'vbscript:x',
    ]) {
      expect(resolvePreviewLink(url, '/n/index.md')).toEqual({ kind: 'ignored' })
    }
  })

  it('ignores relative links when there is no document path to resolve against', () => {
    expect(resolvePreviewLink('target.md', null)).toEqual({ kind: 'ignored' })
    expect(resolvePreviewLink('target.md', '')).toEqual({ kind: 'ignored' })
  })

  it('ignores empty hrefs', () => {
    expect(resolvePreviewLink('   ', '/n/index.md')).toEqual({ kind: 'ignored' })
  })

  it('treats URL parser failures as ignored instead of throwing', () => {
    const OriginalURL = globalThis.URL
    class ThrowingURL {
      constructor() {
        throw new Error('bad url')
      }
    }
    globalThis.URL = ThrowingURL as unknown as typeof URL
    try {
      expect(resolvePreviewLink('C:/a.md', null)).toEqual({ kind: 'ignored' })
      expect(resolvePreviewLink('/a.md', 'C:/n/index.md', 'C:/root')).toEqual({ kind: 'ignored' })
      expect(resolvePreviewLink('target.md', '/n/index.md')).toEqual({ kind: 'ignored' })
    } finally {
      globalThis.URL = OriginalURL
    }
  })
})

describe('sameFilePath', () => {
  it('matches the same path across separators and drive-letter case', () => {
    expect(sameFilePath('C:\\Notes\\a.md', 'c:/notes/A.MD')).toBe(true)
  })

  it('returns false for missing or different paths', () => {
    expect(sameFilePath(null, 'a')).toBe(false)
    expect(sameFilePath('a', 'b')).toBe(false)
  })
})

describe('followPreviewLink', () => {
  function deps(overrides: Partial<FollowLinkDeps> = {}): FollowLinkDeps {
    return {
      listDocuments: vi.fn(async () => []),
      importDocument: vi.fn(async () => null),
      selectDocument: vi.fn(async () => true),
      openExternal: vi.fn(),
      openLocalFile: vi.fn(),
      copyTarget: vi.fn(),
      confirmOpenTarget: vi.fn(async () => 'open' as const),
      ...overrides,
    }
  }

  it('opens an already-imported document without re-importing (preserves unsaved edits)', async () => {
    const d = deps({
      listDocuments: vi.fn(async () => [{ id: 'existing', filePath: 'C:\\notes\\target.md' }]),
    })
    await followPreviewLink({ kind: 'document', path: 'c:/notes/TARGET.md' }, d)
    expect(d.importDocument).not.toHaveBeenCalled()
    expect(d.selectDocument).toHaveBeenCalledWith('existing')
    expect(d.confirmOpenTarget).not.toHaveBeenCalled()
  })

  it('delegates to the workspace-aware navigation service when provided', async () => {
    const navigateToDocument = vi.fn(async () => true)
    const d = deps({ navigateToDocument })
    await followPreviewLink({ kind: 'document', path: 'D:/other/target.md' }, d)
    expect(navigateToDocument).toHaveBeenCalledWith('D:/other/target.md')
    expect(d.listDocuments).not.toHaveBeenCalled()
    expect(d.selectDocument).not.toHaveBeenCalled()
  })

  it('imports a document that is not open yet, then selects it', async () => {
    const d = deps({ importDocument: vi.fn(async () => ({ id: 'fresh' })) })
    await followPreviewLink({ kind: 'document', path: 'C:/notes/new.md' }, d)
    expect(d.importDocument).toHaveBeenCalledWith('C:/notes/new.md')
    expect(d.selectDocument).toHaveBeenCalledWith('fresh')
  })

  it('opens external targets in the OS only after the Open / Copy / Cancel choice', async () => {
    const d = deps()
    await followPreviewLink({ kind: 'external', url: 'https://example.com' }, d)
    expect(d.confirmOpenTarget).toHaveBeenCalledWith('https://example.com')
    expect(d.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(d.selectDocument).not.toHaveBeenCalled()
  })

  it('opens local non-Markdown files with the OS default application', async () => {
    const d = deps()
    await followPreviewLink({ kind: 'localFile', path: 'C:/notes/photo.png' }, d)
    expect(d.confirmOpenTarget).toHaveBeenCalledWith('C:/notes/photo.png')
    expect(d.openLocalFile).toHaveBeenCalledWith('C:/notes/photo.png')
    expect(d.openExternal).not.toHaveBeenCalled()
  })

  it('copies the target instead of opening it when Copy is chosen', async () => {
    const d = deps({ confirmOpenTarget: vi.fn(async () => 'copy' as const) })
    await followPreviewLink({ kind: 'localFile', path: '/n/a.pdf' }, d)
    expect(d.copyTarget).toHaveBeenCalledWith('/n/a.pdf')
    expect(d.openLocalFile).not.toHaveBeenCalled()
  })

  it('does nothing when Cancel is chosen', async () => {
    const d = deps({ confirmOpenTarget: vi.fn(async () => 'cancel' as const) })
    await followPreviewLink({ kind: 'external', url: 'https://example.com' }, d)
    expect(d.openExternal).not.toHaveBeenCalled()
    expect(d.copyTarget).not.toHaveBeenCalled()
  })

  it('swallows import failures instead of throwing', async () => {
    const d = deps({ importDocument: vi.fn(async () => Promise.reject(new Error('boom'))) })
    await expect(followPreviewLink({ kind: 'document', path: 'x.md' }, d)).resolves.toBeUndefined()
  })

  it('selects nothing when a document cannot be resolved from list or import', async () => {
    const d = deps({ importDocument: vi.fn(async () => null) })
    await followPreviewLink({ kind: 'document', path: 'missing.md' }, d)
    expect(d.selectDocument).not.toHaveBeenCalled()
  })

  it('ignores targets that are neither documents nor external links', async () => {
    const d = deps()
    await followPreviewLink({ kind: 'anchor', id: 'top' }, d)
    await followPreviewLink({ kind: 'ignored' }, d)
    expect(d.confirmOpenTarget).not.toHaveBeenCalled()
    expect(d.openExternal).not.toHaveBeenCalled()
  })
})
