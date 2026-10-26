// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createWordIndex } from './word-boundary'

// These assertions LOCK the ICU segmentation (D35). They are not "does it vaguely work" tests: if
// a Node/ICU upgrade changes how Chinese or Japanese is segmented, whole-word matching silently
// changes meaning, and this file is what makes that upgrade fail loudly instead.
describe('UAX #29 word segmentation is what D35 assumes', () => {
  it('splits Chinese with a dictionary, so 中文 is ONE word', () => {
    // Verified on Node v22 with full-icu. Without the dictionary this degenerates to per-character
    // segments, at which point whole-word becomes a no-op for Chinese.
    const seg = new Intl.Segmenter('en', { granularity: 'word' })
    expect([...seg.segment('这是中文文本')].map((s) => `${s.segment}@${s.index}`)).toEqual([
      '这@0',
      '是@1',
      '中文@2',
      '文本@4',
    ])
  })

  it('splits Japanese the same way', () => {
    const seg = new Intl.Segmenter('en', { granularity: 'word' })
    expect([...seg.segment('食べることが')].map((s) => `${s.segment}@${s.index}`)).toEqual([
      '食べる@0',
      'こと@3',
      'が@5',
    ])
  })

  it('is locale-independent: Chinese segmented with zh matches en', () => {
    // ICU picks its rules by the script of the text, not by the locale — which is why the module
    // can pin one locale and still behave identically on every machine.
    const en = [...new Intl.Segmenter('en', { granularity: 'word' }).segment('这是中文文本')].map(
      (s) => s.segment,
    )
    const zh = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment('这是中文文本')].map(
      (s) => s.segment,
    )
    expect(en).toEqual(zh)
  })
})

describe('createWordIndex', () => {
  it('accepts a whole word and rejects an in-word slice', () => {
    const w = createWordIndex('Hello World')
    expect(w.isWordStart(0)).toBe(true)
    expect(w.isWordEnd(5)).toBe(true)
    expect(w.isWordStart(6)).toBe(true)
    expect(w.isWordEnd(11)).toBe(true)
    // "ell" sits inside "Hello".
    expect(w.isWordStart(1)).toBe(false)
    expect(w.isWordEnd(4)).toBe(false)
  })

  it('treats an apostrophe as joining, so the fast path never accepts on ASCII punctuation', () => {
    const w = createWordIndex("don't")
    expect(w.isWordStart(4)).toBe(false)
  })

  it('handles a match that starts at the very beginning and ends at the very end', () => {
    const w = createWordIndex('solo')
    expect(w.isWordStart(0)).toBe(true)
    expect(w.isWordEnd(4)).toBe(true)
  })

  it('has no boundary at position 0 for isWordEnd', () => {
    // Guards the `pos <= 0` branch: an empty match would ask for end 0, which cannot be a hit.
    expect(createWordIndex('abc').isWordEnd(0)).toBe(true)
  })
})
