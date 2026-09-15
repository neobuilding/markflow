import { describe, it, expect } from 'vitest'
import { fontFamilyOf, pruneRedundantFontAssets } from './prune-fonts'

// Minimal fake bundle: the pruning logic only inspects the file-name keys.
function bundleOf(...fileNames: string[]): Record<string, unknown> {
  const bundle: Record<string, unknown> = {}
  for (const fileName of fileNames) bundle[fileName] = { type: 'asset', fileName, source: '' }
  return bundle
}

describe('fontFamilyOf', () => {
  it('strips the Vite content hash and keeps the KaTeX family', () => {
    expect(fontFamilyOf('assets/KaTeX_AMS-Regular-BQhdFMY1.woff2')).toBe('KaTeX_AMS-Regular')
    expect(fontFamilyOf('assets/KaTeX_Main-Regular-Dr94JaBh.woff')).toBe('KaTeX_Main-Regular')
  })

  it('handles hashes that themselves contain - or _ (base64url)', () => {
    expect(fontFamilyOf('assets/KaTeX_Size4-Regular-BF-4gkZK.woff')).toBe('KaTeX_Size4-Regular')
    expect(fontFamilyOf('assets/KaTeX_Math-Italic-t53AETM-.woff2')).toBe('KaTeX_Math-Italic')
    expect(fontFamilyOf('assets/KaTeX_Fraktur-Regular-CB_wures.ttf')).toBe('KaTeX_Fraktur-Regular')
  })
})

// REGRESSION: only an EXACT 8-char Vite hash may be stripped. A looser suffix match
// would eat the font's own style suffix (`KaTeX_Main-Regular` -> `KaTeX_Main`) and
// merge Bold/Italic/Regular into one family, letting a Bold `.woff2` delete
// Regular's `.ttf`. When there is no hash the full name must survive.
describe('fontFamilyOf — style suffix is never mistaken for a hash', () => {
  it('keeps the style suffix when the file has no Vite hash', () => {
    expect(fontFamilyOf('assets/KaTeX_Main-Regular.woff')).toBe('KaTeX_Main-Regular')
    expect(fontFamilyOf('assets/KaTeX_Main-Regular.ttf')).toBe('KaTeX_Main-Regular')
    expect(fontFamilyOf('assets/KaTeX_Main-BoldItalic.woff2')).toBe('KaTeX_Main-BoldItalic')
  })

  it('never prunes a hashless family just because a sibling style has a woff2', () => {
    const bundle = bundleOf(
      'assets/KaTeX_Main-Bold-AAAAAAAA.woff2', // has a hash
      'assets/KaTeX_Main-Regular.ttf', // no hash
      'assets/KaTeX_Main-Regular.woff', // no hash
    )
    expect(pruneRedundantFontAssets(bundle)).toEqual([])
    expect(Object.keys(bundle).sort()).toEqual([
      'assets/KaTeX_Main-Bold-AAAAAAAA.woff2',
      'assets/KaTeX_Main-Regular.ttf',
      'assets/KaTeX_Main-Regular.woff',
    ])
  })
})

// Locks in the real-world behaviour ADR-0015 relies on, using the actual built asset
// names: MOST families lose .woff/.ttf, but KaTeX_Size3 keeps them because its 3.6 kB
// .woff2 is under Vite's 4 kB `assetsInlineLimit` and is inlined into the CSS as a
// data: URI, so no .woff2 file ever reaches the bundle for it.
describe('pruneRedundantFontAssets — real KaTeX output', () => {
  it('prunes Size4 (woff2 emitted) but keeps Size3 (woff2 inlined as a data: URI)', () => {
    const bundle = bundleOf(
      // Size4: all three formats reach the bundle -> only the woff2 survives.
      'assets/KaTeX_Size4-Regular-Dl5lxZxV.woff2',
      'assets/KaTeX_Size4-Regular-BfT2m1Qa.woff',
      'assets/KaTeX_Size4-Regular-Cj8yN3Rb.ttf',
      // Size3: no woff2 asset (it was inlined) -> its fallbacks must survive.
      'assets/KaTeX_Size3-Regular-CTq5MqoE.woff',
      'assets/KaTeX_Size3-Regular-DgpXs0kz.ttf',
    )
    const removed = pruneRedundantFontAssets(bundle)
    expect(removed.sort()).toEqual([
      'assets/KaTeX_Size4-Regular-BfT2m1Qa.woff',
      'assets/KaTeX_Size4-Regular-Cj8yN3Rb.ttf',
    ])
    expect(Object.keys(bundle).sort()).toEqual([
      'assets/KaTeX_Size3-Regular-CTq5MqoE.woff',
      'assets/KaTeX_Size3-Regular-DgpXs0kz.ttf',
      'assets/KaTeX_Size4-Regular-Dl5lxZxV.woff2',
    ])
  })
})

describe('pruneRedundantFontAssets', () => {
  it('removes .woff/.ttf when a .woff2 of the same family exists', () => {
    const bundle = bundleOf(
      'assets/KaTeX_Main-Regular-B22Nviop.woff2',
      'assets/KaTeX_Main-Regular-Dr94JaBh.woff',
      'assets/KaTeX_Main-Regular-ypZvNtVU.ttf',
    )
    const removed = pruneRedundantFontAssets(bundle)
    expect(removed.sort()).toEqual([
      'assets/KaTeX_Main-Regular-Dr94JaBh.woff',
      'assets/KaTeX_Main-Regular-ypZvNtVU.ttf',
    ])
    expect(Object.keys(bundle)).toEqual(['assets/KaTeX_Main-Regular-B22Nviop.woff2'])
  })

  it('keeps a family that has no .woff2 asset (never break a font)', () => {
    const bundle = bundleOf(
      'assets/KaTeX_Fraktur-Regular-CB_wures.ttf',
      'assets/KaTeX_Fraktur-Regular-Dxdc4cR9.woff',
    )
    expect(pruneRedundantFontAssets(bundle)).toEqual([])
    expect(Object.keys(bundle).sort()).toEqual([
      'assets/KaTeX_Fraktur-Regular-CB_wures.ttf',
      'assets/KaTeX_Fraktur-Regular-Dxdc4cR9.woff',
    ])
  })

  it('leaves non-font assets untouched', () => {
    const bundle = bundleOf(
      'assets/index-Bx1.js',
      'assets/index-Cy2.css',
      'assets/KaTeX_AMS-Regular-BQhdFMY1.woff2',
      'assets/KaTeX_AMS-Regular-DMm9YOAa.woff',
    )
    expect(pruneRedundantFontAssets(bundle)).toEqual(['assets/KaTeX_AMS-Regular-DMm9YOAa.woff'])
    expect(Object.keys(bundle).sort()).toEqual([
      'assets/KaTeX_AMS-Regular-BQhdFMY1.woff2',
      'assets/index-Bx1.js',
      'assets/index-Cy2.css',
    ])
  })

  it('returns an empty array when there are no fonts', () => {
    expect(pruneRedundantFontAssets(bundleOf('assets/index-Bx1.js'))).toEqual([])
  })
})
