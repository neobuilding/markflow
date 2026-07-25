// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { detectEncoding, normEnc, readMarkdownText } from '../documents'
import iconv from 'iconv-lite'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('encoding — detectEncoding (R5)', () => {
  it('BOM 优先：UTF-8 BOM', () => {
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
  it('检测器命中 GBK（中文）', () => {
    // 4 字节样本（“中文”）太短易被误判为 koi8-r，用更长的中文段落提升置信度。
    const gbk = iconv.encode('中文编码检测测试文档内容一致性校验', 'gbk')
    const r = detectEncoding(gbk)
    expect(r.enc).toBe('gbk')
    expect(r.confidence).toBeGreaterThanOrEqual(0.6)
  })
  it('纯 ASCII 回退 ascii/utf-8 兼容编码（不误判为多字节）', () => {
    const buf = Buffer.from('hello world')
    const r = detectEncoding(buf)
    expect(['utf-8', 'ascii']).toContain(r.enc)
    expect(typeof r.confidence).toBe('number')
  })
  it('强置信的非 CJK 编码不被 CJK 候选误覆盖（西里尔 windows-1251）', () => {
    // 西里尔文本：GBK 解码任意字节常 0 替换符，若二次判断无闸门会误判为 gbk。
    const cyrillic = iconv.encode('Привет мир, это тест кодировки Windows-1251 для проверки детектора', 'windows-1251')
    const r = detectEncoding(cyrillic)
    expect(['gbk', 'big5', 'shift_jis', 'euc-kr']).not.toContain(r.enc)
  })
  it('UTF-8 含中文内容仍判为 UTF-8（不被 CJK 候选抢走）', () => {
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
  it('从文件解码 GBK 并保持字节级无损', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-enc-'))
    const p = join(dir, 't.md')
    const sample = '中文编码检测测试文档内容一致性校验'
    writeFileSync(p, iconv.encode(sample, 'gbk'))
    const { text, encoding } = readMarkdownText(p)
    expect(encoding).toBe('gbk')
    expect(text).toBe(sample)
  })
})
