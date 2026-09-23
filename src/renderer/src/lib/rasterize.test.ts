// Unit coverage for the pure pieces of the rasterizer (ADR-0004: every lib file 100%).
// The <img>/<canvas> pipeline itself cannot run under jsdom and is covered by the e2e suite; what
// we lock here is the security-relevant choice of URL scheme and the SIZE math, which is what the
// "diagram is blurry / too small" bug came from.
import { describe, it, expect } from 'vitest'
import { RASTER_SCALE, rasterPixelSize, svgDataUrl, svgIntrinsicSize } from './rasterize'

describe('svgDataUrl', () => {
  it('returns a data: URL and never a blob: URL (the app CSP blocks blob: img sources)', () => {
    const url = svgDataUrl('<svg viewBox="0 0 10 10"><rect/></svg>')
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(url).not.toContain('blob:')
  })

  it('percent-encodes the SVG so it survives as a URL', () => {
    const url = svgDataUrl('<svg><text>a & b #c</text></svg>')
    expect(url).toContain('%3Csvg%3E')
    expect(url).not.toContain('#')
    expect(url).not.toContain('&')
  })
})

describe('svgIntrinsicSize', () => {
  it('reads the viewBox of a percentage-sized SVG (the mermaid shape)', () => {
    // Regression: mermaid emits width="100%" + viewBox, for which the browser reports a 300x150
    // default natural size — the old code trusted it and produced a bitmap SMALLER than the
    // diagram on screen (110x300 for a diagram shown at 181x499), hence "blurry".
    const size = svgIntrinsicSize(
      '<svg width="100%" style="max-width: 181px" viewBox="4.5 4 181.33 498.67"></svg>',
    )
    expect(size).toEqual({ width: 181.33, height: 498.67 })
  })

  it('prefers absolute width/height attributes over the viewBox', () => {
    const size = svgIntrinsicSize('<svg width="640" height="480" viewBox="0 0 10 10"></svg>')
    expect(size).toEqual({ width: 640, height: 480 })
  })

  it('ignores percentages and accepts pt-style lengths', () => {
    // `100%` is not a usable pixel size, so the viewBox still decides…
    expect(svgIntrinsicSize('<svg width="100%" height="100%" viewBox="0 0 20 30"></svg>')).toEqual({
      width: 20,
      height: 30,
    })
    // …while a parseable absolute length (here `pt`) is used as-is.
    expect(svgIntrinsicSize('<svg width="120pt" height="60pt"></svg>')).toEqual({
      width: 120,
      height: 60,
    })
  })

  it('returns null when the markup carries no usable size', () => {
    expect(svgIntrinsicSize('<svg viewBox="0 0 10"></svg>')).toBeNull()
    expect(svgIntrinsicSize('<svg width="0" height="0"></svg>')).toBeNull()
    expect(svgIntrinsicSize('<svg></svg>')).toBeNull()
    // Half a pair is not a size: a percentage height must not be paired with a pixel width.
    expect(svgIntrinsicSize('<svg width="100" height="100%"></svg>')).toBeNull()
  })
})

describe('rasterPixelSize', () => {
  it('scales by RASTER_SCALE so the target can re-scale without softening', () => {
    expect(RASTER_SCALE).toBe(2)
    expect(rasterPixelSize({ width: 181.33, height: 498.67 })).toEqual({ width: 363, height: 997 })
  })

  it('honours an explicit scale override', () => {
    expect(rasterPixelSize({ width: 10, height: 20 }, 1)).toEqual({ width: 10, height: 20 })
  })

  it('caps the long edge (one giant diagram cannot blow the payload up)', () => {
    // 4000x2000 at 2x would be 8000px wide; the cap keeps the long edge at 2000.
    expect(rasterPixelSize({ width: 4000, height: 2000 })).toEqual({ width: 2000, height: 1000 })
  })

  it('never produces a zero-pixel canvas', () => {
    expect(rasterPixelSize({ width: 0.1, height: 0.1 })).toEqual({ width: 1, height: 1 })
  })
})
