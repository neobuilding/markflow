// Whole-word ("`ab`") matching on UAX #29 word boundaries (ADR-0023 D35).
//
// The naive implementations are both wrong, in OPPOSITE directions, which is why neither is used:
//
//   * `\w` = `[A-Za-z0-9_]`, and Han characters are NOT `\w`, so `(?<!\w)cn(?!\\w)` is always
//     true and the toggle silently does nothing. That is the failure the preview surface has
//     today, and the reason "whole word does not work for Chinese" gets reported.
//   * `\p{L}` DOES include Han, so `(?<!\p{L})cn(?!\\p{L})` is always false: never matches.
//
// The correct definition is "both ends of the match fall on a word boundary", which is what
// `Intl.Segmenter` with `granularity: 'word'` gives. ICU ships a dictionary for Han, so a Han run
// IS a single word segment: it matches inside "zhe shi zhongwen wenben" as one word while a slice
// straddling two Han runs does not. Verified on Node v22 with full-icu, and locked by tests in
// `word-boundary.test.ts` so an ICU upgrade that changes the segmentation cannot pass unnoticed.
//
// The locale is fixed to 'en' and that is deliberate: ICU selects its rules by the SCRIPT of the
// text, not by the locale, so segmenting Chinese with 'en' yields the same segments as with 'zh'.
// Picking one locale keeps results identical on every machine instead of depending on the OS.
const WORD_SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' })

// `[A-Za-z0-9_]`. Used only as a fast REJECT: an ASCII word character next to the match means the
// two cannot be a segment edge, so the (comparatively expensive) segmenter can be skipped. This is
// the fast path D35 asks for on pure-Latin text. It is never used to accept, because some ASCII
// punctuation (notably apostrophe and period) is MidNumLet / MidLetter and therefore joins words
// ("don't" is ONE segment), which a fast accept would get wrong.
function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f // _
  )
}

export interface WordIndex {
  /** True when a match starting at `pos` begins a whole word. */
  isWordStart(pos: number): boolean
  /** True when a match ending at `pos` ends a whole word. */
  isWordEnd(pos: number): boolean
}

/** Build the boundary oracle for one document body. Cheap: the segmenter is lazy. */
export function createWordIndex(content: string): WordIndex {
  const segments = WORD_SEGMENTER.segment(content)
  return {
    isWordStart(pos) {
      if (pos > 0 && isAsciiWordChar(content.charCodeAt(pos - 1))) return false
      const found = segments.containing(pos)
      return !!found && found.index === pos
    },
    isWordEnd(pos) {
      if (pos <= 0) return true
      if (pos < content.length && isAsciiWordChar(content.charCodeAt(pos))) return false
      const found = segments.containing(pos - 1)
      return !!found && found.index + found.segment.length === pos
    },
  }
}
