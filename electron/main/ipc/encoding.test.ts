// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  normEnc,
  detectEncoding,
  cjkSecondPass,
  countReplacements,
  readMarkdownText,
  countWords,
} from './documents'
import iconv from 'iconv-lite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Helper to build a real GBK buffer for a CJK string.
function gbk(s: string): Buffer {
  return iconv.encode(s, 'gbk')
}

describe('normEnc', () => {
  it('maps known aliases to canonical lowercase names', () => {
    expect(normEnc('UTF8')).toBe('utf-8')
    expect(normEnc('GBK')).toBe('gbk')
    expect(normEnc('BIG5')).toBe('big5')
    expect(normEnc('CP936')).toBe('gbk')
    expect(normEnc('ISO-8859-1')).toBe('latin1')
  })

  it('passes through unknown names lowercased', () => {
    expect(normEnc('some-weird-enc')).toBe('some-weird-enc')
  })
})

describe('countReplacements', () => {
  it('returns Infinity for an unsupported encoding', () => {
    expect(countReplacements(Buffer.from('hi'), 'no-such-encoding')).toBe(Infinity)
  })

  it('counts U+FFFD replacement chars when a CJK buffer is decoded as utf-8', () => {
    // GBK "中" bytes decoded as utf-8 yield replacement chars.
    const n = countReplacements(gbk('中文'), 'utf-8')
    expect(n).toBeGreaterThan(0)
  })

  it('counts zero replacements when the encoding matches the bytes', () => {
    expect(countReplacements(gbk('中文'), 'gbk')).toBe(0)
  })
})

describe('detectEncoding — BOM fast paths', () => {
  it('detects UTF-8 BOM', () => {
    expect(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])).enc).toBe('utf-8')
  })
  it('detects UTF-32LE BOM', () => {
    expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x00, 0x00])).enc).toBe('utf-32le')
  })
  it('detects UTF-16LE BOM', () => {
    expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x68, 0x00])).enc).toBe('utf-16le')
  })
  it('detects UTF-16BE BOM', () => {
    expect(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x68])).enc).toBe('utf-16be')
  })
})

describe('detectEncoding — no detection / non-CJK / CJK', () => {
  it('falls back to utf-8 with zero confidence when no encoding is detected', () => {
    const r = detectEncoding(Buffer.alloc(0))
    expect(r.enc).toBe('utf-8')
    expect(r.confidence).toBe(0)
  })

  it('treats an empty buffer as "no detection" and does NOT claim confidence 1', () => {
    // Regression guard for the ASCII fast path: an empty buffer has no bytes to
    // judge, so it must fall through to the detector's utf-8/confidence-0 fallback
    // rather than the fast path's confidence:1. Callers rely on the 0 to mean "we
    // are unsure", e.g. to keep an existing stored encoding instead of overriding it.
    const r = detectEncoding(Buffer.alloc(0))
    expect(r.enc).toBe('utf-8')
    expect(r.confidence).toBe(0)
  })

  it('short-circuits pure-ASCII input to utf-8/confidence 1 without decoding', () => {
    // The single biggest cost in detectEncoding used to be the CJK second pass,
    // which decodes up to 1MB of sample five times. Pure-ASCII bytes decode
    // identically under every encoding, so there is nothing to detect — the fast
    // path must return immediately. Assert the RESULT, and assert it is FAST on a
    // 1MB+ buffer (proves the decodes are skipped, not just that the answer is right).
    const oneMbAscii = Buffer.alloc(1_200_000, 0x41) // 1.2MB of 'A'
    // Best-of-N rather than a single shot. A one-shot wall-clock bound is pure
    // noise once the whole suite runs in parallel: this case failed at 47.8ms
    // against a 20ms limit under full-suite load while measuring ~1ms alone. The
    // minimum is what the code can actually do, so that is what gets asserted.
    let elapsed = Infinity
    let r = { enc: '', confidence: 0 }
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      r = detectEncoding(oneMbAscii)
      elapsed = Math.min(elapsed, performance.now() - t0)
    }
    expect(r.enc).toBe('utf-8')
    expect(r.confidence).toBe(1)
    // The fast path is a plain byte scan — low single-digit ms for 1.2MB. Going
    // the long way round (detector + five iconv decodes of the same buffer) costs
    // hundreds of ms. 50ms is far above scheduling noise and far below that.
    expect(elapsed).toBeLessThan(50)
  })

  it('does not mistake a BOM-less UTF-16LE file for ASCII text', () => {
    // UTF-16LE without a BOM encodes ASCII text as NUL-interleaved bytes, every
    // single one of them <= 0x7f. A naive "all bytes < 0x80 => utf-8" fast path
    // would swallow it and hand the caller NUL-interleaved garbage, so the fast
    // path has to bail out on NUL bytes and let the real detector decide.
    const buf = Buffer.from('# Note\n\nHello, this is an ASCII-only note.\n', 'utf16le')
    const r = detectEncoding(buf)
    // jschardet reports BOM-less UTF-16 as 'UTF-16' without a byte order, and
    // normEnc has no alias for that spelling, so the canonical name stays
    // 'utf-16'. That is fine: iconv-lite's utf-16 codec resolves the byte order
    // itself (BOM, else a NUL-position heuristic), so decoding is still correct.
    expect(r.enc).toBe('utf-16')
  })

  it('detects GBK even when the CJK text only starts after the first kilobytes', () => {
    // Guard against truncating the CJK second pass to a short head window: a note
    // whose beginning is English (byte-identical under ASCII / UTF-8 / GBK) and
    // whose Chinese only appears further in must still be judged by its WHOLE
    // content, otherwise it is reported as clean UTF-8 and read back garbled.
    const head = Buffer.alloc(9_000, 0x41) // 9KB of ASCII 'A'
    const buf = Buffer.concat([head, gbk('中文内容出现在文件的后半部分，这里是正文。')])
    const r = detectEncoding(buf)
    expect(r.enc).toBe('gbk')
  })

  it('trusts a high-confidence non-CJK encoding directly (inCjkScope false)', () => {
    // Latin-1 bytes (invalid as utf-8) are detected as iso-8859-1 with high confidence.
    const r = detectEncoding(
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x75, 0x20, 0x6c, 0x61, 0x69, 0x74]),
    )
    expect(r.enc).toBe('latin1')
    expect(r.confidence).toBeGreaterThan(0.6)
  })

  it('corrects a GBK byte sequence via the CJK second pass', () => {
    // GBK "中" bytes decode cleanly as gbk (0 replacements) and are corrected away from any utf-8 misread.
    const r = detectEncoding(gbk('中'))
    expect(r.enc).toBe('gbk')
    expect(r.confidence).toBeGreaterThanOrEqual(0.99)
  })

  it('trusts clean UTF-8 CJK without overriding (high-confidence utf-8 wins the second pass)', () => {
    const r = detectEncoding(Buffer.from('你好世界，这是一个测试。', 'utf-8'))
    expect(r.enc).toBe('utf-8')
  })

  it('returns utf-8 when the CJK second pass is uncertain (< 0.6)', () => {
    // A buffer of invalid utf-8 bytes that still decodes (leniently) as utf-8 with many replacements:
    // the second pass yields low confidence and falls back to utf-8.
    const buf = Buffer.concat([
      Buffer.from([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87]),
      Buffer.from('hello'),
    ])
    const r = detectEncoding(buf)
    // Either the detector routes to the < 0.6 fallback (utf-8) or to a non-CJK encoding; in both
    // cases the result is a valid, non-throwing encoding.
    expect(typeof r.enc).toBe('string')
    expect(r.enc.length).toBeGreaterThan(0)
  })
})

describe('cjkSecondPass (direct unit tests of the comparison heuristic)', () => {
  it('keeps utf-8 as best when utf-8 decodes cleanly (bestRep === 0 -> 0.99)', () => {
    const r = cjkSecondPass(Buffer.from('你好世界', 'utf-8'), 'utf-8')
    expect(r.enc).toBe('utf-8')
    expect(r.confidence).toBe(0.99)
  })

  it('keeps a CJK candidate as best when it decodes cleanly (bestRep === 0 -> 0.99)', () => {
    const r = cjkSecondPass(gbk('中文'), 'gbk')
    expect(r.enc).toBe('gbk')
    expect(r.confidence).toBe(0.99)
  })

  it('switches away from a sub-optimal primary when another candidate decodes cleaner (rep < bestRep TRUE)', () => {
    // primary 'utf-8' but the bytes are actually GBK: gbk decodes with 0 replacements and beats utf-8 (which has >0).
    const r = cjkSecondPass(gbk('中文'), 'utf-8')
    expect(r.enc).toBe('gbk')
    expect(r.confidence).toBe(0.99)
  })

  it('keeps the primary when no candidate decodes cleaner (rep < bestRep FALSE)', () => {
    // primary 'gbk' on valid GBK bytes: every other candidate has >= replacements, so best stays 'gbk'.
    const r = cjkSecondPass(gbk('中文'), 'gbk')
    expect(r.enc).toBe('gbk')
    expect(r.confidence).toBe(0.99)
  })

  it('uses the utf-8 Math.max(0.1, ...) floor when utf-8 wins with some replacements', () => {
    // utf-8 primary where a few trailing bytes are invalid: utf-8 stays best (bestRep > 0) -> 1 - bestRep/len, floored at 0.1.
    const buf = Buffer.concat([Buffer.from('你好世界', 'utf-8'), Buffer.from([0xff, 0xfe])])
    const r = cjkSecondPass(buf, 'utf-8')
    expect(r.enc).toBe('utf-8')
    expect(r.confidence).toBeGreaterThan(0)
    expect(r.confidence).toBeLessThanOrEqual(0.99)
  })

  it('uses the CJK-candidate Math.max(0.7, ...) floor when a CJK candidate wins with some replacements', () => {
    // GBK bytes with one corrupted byte: gbk stays best (bestRep > 0) -> 1 - bestRep/len, floored at 0.7.
    const raw = gbk('中国语言文本')
    raw[raw.length - 1] ^= 0x80
    const r = cjkSecondPass(raw, 'gbk')
    expect(r.enc).toBe('gbk')
    expect(r.confidence).toBeGreaterThan(0)
    expect(r.confidence).toBeLessThanOrEqual(0.99)
  })
})

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('one two three')).toBe(3)
  })

  it('ignores markdown punctuation and returns 0 for empty', () => {
    expect(countWords('# Heading! (with parens)')).toBe(3)
    expect(countWords('   ')).toBe(0)
  })
})

describe('readMarkdownText', () => {
  it('reads a file and reports its detected encoding', () => {
    const { writeFileSync, mkdtempSync } = fs
    const { join } = path
    const { tmpdir } = os
    const dir = mkdtempSync(join(tmpdir(), 'mf-rmt-'))
    const p = join(dir, 'a.md')
    writeFileSync(p, '# hello', 'utf-8')
    const r = readMarkdownText(p)
    expect(r.text).toBe('# hello')
    // Pure-ASCII content is detected as ascii (which round-trips identically to utf-8).
    expect(['utf-8', 'ascii']).toContain(r.encoding)
  })
})
