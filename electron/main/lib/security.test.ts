// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseAppDocUrl, isSubdir } from './security'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Every temp dir here is allocated through the registry, which reclaims it when the suite
// finishes (test-setup.ts) — no hand-rolled cleanup list to forget to extend.
import { mkTestDir } from '../test-support/tmp'

describe('parseAppDocUrl (R4/R6 appdoc parsing)', () => {
  it('docId is placed in the hostname', () => {
    expect(parseAppDocUrl('appdoc://doc-123/a.png')).toEqual({ docId: 'doc-123', relPath: 'a.png' })
  })
  it('subdirectory relative paths preserve hierarchy', () => {
    expect(parseAppDocUrl('appdoc://doc-123/img/photo.png')).toEqual({
      docId: 'doc-123',
      relPath: 'img/photo.png',
    })
  })
  it('filename with spaces is percent-decoded', () => {
    expect(parseAppDocUrl('appdoc://doc-123/my%20photo.png')).toEqual({
      docId: 'doc-123',
      relPath: 'my photo.png',
    })
  })
  it('non-appdoc protocol returns null (should not inline)', () => {
    expect(parseAppDocUrl('https://example.com/a.png')).toBeNull()
    expect(parseAppDocUrl('data:image/png;base64,AAAA')).toBeNull()
  })
  it('missing relative path returns null (404)', () => {
    expect(parseAppDocUrl('appdoc://doc-123')).toBeNull()
  })
  it('invalid URL returns null (no throw)', () => {
    expect(parseAppDocUrl('not a url')).toBeNull()
  })
  it('non-canonical form appdoc:doc-123/a.png (missing //) returns null', () => {
    expect(parseAppDocUrl('appdoc:doc-123/a.png')).toBeNull()
  })
  it('hostname with illegal characters returns null', () => {
    expect(parseAppDocUrl('appdoc://doc 123/a.png')).toBeNull()
  })
  it('hostname with a dot (not an allowed identifier char) returns null', () => {
    expect(parseAppDocUrl('appdoc://doc.123/a.png')).toBeNull()
  })

  it('falls back to the raw path when decodeURIComponent throws (malformed %)', () => {
    const out = parseAppDocUrl('appdoc://doc1/%E0%A4')
    expect(out).toEqual({ docId: 'doc1', relPath: '%E0%A4' })
  })
})

describe('isSubdir traversal prevention (R4/R6)', () => {
  it('allows subdirectory / file', () => {
    const dir = mkTestDir('mf-sub-')
    const child = join(dir, 'a.png')
    writeFileSync(child, 'x') // isSubdir uses realpathSync, so the file must really exist
    expect(isSubdir(dir, child)).toBe(true)
  })
  it('blocks privilege-escalation path (../ escape)', () => {
    const dir = mkTestDir('mf-prev-')
    const outsideDir = mkTestDir('mf-prev-out-')
    const outside = join(outsideDir, 'x')
    writeFileSync(outside, 'x')
    expect(isSubdir(dir, outside)).toBe(false)
  })
})
