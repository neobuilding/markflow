// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { parseAppDocUrl, isSubdir } from '../security'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Collect the temp dirs/files created by this test and clean them up after each case, to
// avoid polluting the system temp directory.
const tmpArtifacts: string[] = []
afterEach(() => {
  for (const p of tmpArtifacts) {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {
      /* ignore cleanup failures */
    }
  }
  tmpArtifacts.length = 0
})

describe('parseAppDocUrl (R4/R6 appdoc 解析)', () => {
  it('docId 落在 hostname', () => {
    expect(parseAppDocUrl('appdoc://doc-123/a.png')).toEqual({ docId: 'doc-123', relPath: 'a.png' })
  })
  it('子目录相对路径保留层级', () => {
    expect(parseAppDocUrl('appdoc://doc-123/img/photo.png')).toEqual({
      docId: 'doc-123',
      relPath: 'img/photo.png',
    })
  })
  it('文件名含空格 → percent-decode 还原', () => {
    expect(parseAppDocUrl('appdoc://doc-123/my%20photo.png')).toEqual({
      docId: 'doc-123',
      relPath: 'my photo.png',
    })
  })
  it('非 appdoc 协议 → null（不应内联）', () => {
    expect(parseAppDocUrl('https://example.com/a.png')).toBeNull()
    expect(parseAppDocUrl('data:image/png;base64,AAAA')).toBeNull()
  })
  it('缺少相对路径 → null（404）', () => {
    expect(parseAppDocUrl('appdoc://doc-123')).toBeNull()
  })
  it('非法 URL → null（不抛异常）', () => {
    expect(parseAppDocUrl('not a url')).toBeNull()
  })
})

describe('isSubdir 防穿越 (R4/R6)', () => {
  it('允许子目录/文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-sub-'))
    tmpArtifacts.push(dir)
    const child = join(dir, 'a.png')
    writeFileSync(child, 'x') // isSubdir 用 realpathSync，需文件真实存在
    expect(isSubdir(dir, child)).toBe(true)
  })
  it('拦截越权路径（../ 逃逸）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-prev-'))
    tmpArtifacts.push(dir)
    const outsideDir = mkdtempSync(join(tmpdir(), 'mf-prev-out-'))
    tmpArtifacts.push(outsideDir)
    const outside = join(outsideDir, 'x')
    writeFileSync(outside, 'x')
    expect(isSubdir(dir, outside)).toBe(false)
  })
})
