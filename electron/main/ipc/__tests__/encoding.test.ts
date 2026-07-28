// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { detectEncoding, normEnc, readMarkdownText } from '../documents'
import iconv from 'iconv-lite'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('encoding — detectEncoding (R5)', () => {
  it('BOM precedence: UTF-8 BOM', () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x42])
    expect(detectEncoding(buf)).toEqual({ enc: 'utf-8', confidence: 1 })
  })
  it('UTF-16LE BOM', () => {
    const buf = Buffer.from([0xff, 0xfe, 0x41, 0x00])
    expect(detectEncoding(buf)).toEqual({ enc: 'utf-16le', confidence: 1 })
  })
  it('UTF-16BE BOM', () => {
    const buf = Buffer.from([0xfe, 0xff, 0x00, 0x41])
    expect(detectEncoding(buf)).toEqual({ enc: 'utf-16be', confidence: 1 })
  })
  it('detector matches GBK (Chinese)', () => {
    // A 4-byte sample ("中文") is too short and easily misclassified as koi8-r; use a longer
    // Chinese paragraph to raise confidence.
    const gbk = iconv.encode('中文编码检测测试文档内容一致性校验', 'gbk')
    const r = detectEncoding(gbk)
    expect(r.enc).toBe('gbk')
    expect(r.confidence).toBeGreaterThanOrEqual(0.6)
  })
  it('plain ASCII falls back to ascii/utf-8 compatible encoding (not misdetected as multi-byte)', () => {
    const buf = Buffer.from('hello world')
    const r = detectEncoding(buf)
    expect(['utf-8', 'ascii']).toContain(r.enc)
    expect(typeof r.confidence).toBe('number')
  })
  it('high-confidence non-CJK encoding is not overridden by CJK candidates (Cyrillic windows-1251)', () => {
    // Cyrillic text: GBK decodes arbitrary bytes to the 0 replacement char, so without a gate
    // on the second-stage check it would be misclassified as gbk.
    const cyrillic = iconv.encode(
      'Привет мир, это тест кодировки Windows-1251 для проверки детектора',
      'windows-1251',
    )
    const r = detectEncoding(cyrillic)
    expect(['gbk', 'big5', 'shift_jis', 'euc-kr']).not.toContain(r.enc)
  })
  it('UTF-8 with Chinese content is still detected as UTF-8 (not stolen by CJK candidates)', () => {
    const utf8 = Buffer.from('这是一段 UTF-8 编码的中文内容，用于验证不会误判为 GBK。'.repeat(4))
    const r = detectEncoding(utf8)
    expect(r.enc).toBe('utf-8')
    expect(r.confidence).toBeGreaterThanOrEqual(0.6)
  })
})

describe('encoding — normEnc 别名映射 (R5)', () => {
  it('GB2312 → gbk', () => expect(normEnc('GB2312')).toBe('gbk'))
  it('UTF8 → utf-8', () => expect(normEnc('UTF8')).toBe('utf-8'))
  it('UTF16 → utf-16le', () => expect(normEnc('UTF16')).toBe('utf-16le'))
  it('WINDOWS-1252 → win1252', () => expect(normEnc('WINDOWS-1252')).toBe('win1252'))
})

describe('encoding — readMarkdownText 往返 (R5)', () => {
  it('decodes GBK from a file and preserves byte-level fidelity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-enc-'))
    const p = join(dir, 't.md')
    const sample = '中文编码检测测试文档内容一致性校验'
    writeFileSync(p, iconv.encode(sample, 'gbk'))
    const { text, encoding } = readMarkdownText(p)
    expect(encoding).toBe('gbk')
    expect(text).toBe(sample)
  })
})
