import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildFormulaSvg,
  stripFontFaces,
  katexFontFaceCss,
  resetKatexFontCache,
  fontSizeOf,
  formulaToPng,
  measureTightBox,
  FORMULA_PADDING,
  FORMULA_SCALE,
} from './formulaImage'
import * as rasterize from './rasterize'

// jsdom has no <img>/<canvas> pipeline, so the real rasterization is held out (it is covered by
// e2e). Everything else — SVG assembly, font inlining, measurement, failure handling — is pure
// enough to assert here.
const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const FONT_FACE_RULE = 5

/** A `@font-face` rule shaped like the ones the browser exposes for katex.min.css. */
function fontFaceRule(family: string, cssText: string) {
  return {
    type: FONT_FACE_RULE,
    cssText,
    style: { getPropertyValue: (prop: string) => (prop === 'font-family' ? family : '') },
  }
}

function setStyleSheets(sheets: unknown[]): void {
  Object.defineProperty(document, 'styleSheets', {
    value: sheets as unknown as StyleSheetList,
    configurable: true,
  })
}

/** A fetch stand-in: Node's Response is unnecessary, only `ok` + `arrayBuffer` are read. */
function stubFetch(impl: () => Promise<unknown>): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

function mountKatex(inner: string): HTMLElement {
  document.body.innerHTML = `<span class="katex">${inner}</span>`
  return document.querySelector('.katex') as HTMLElement
}

const FULL_KATEX =
  '<span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2' +
  '</annotation></semantics></math></span><span class="katex-html">x<sup>2</sup></span>'

beforeEach(() => {
  resetKatexFontCache()
  setStyleSheets([])
  stubFetch(async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([0x41, 0x42]).buffer,
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'styleSheets')
  document.body.innerHTML = ''
})

describe('buildFormulaSvg', () => {
  it('sizes the SVG to the formula plus padding and wraps it in a foreignObject', () => {
    const svg = buildFormulaSvg({
      html: `<span xmlns="${XHTML_NS}" class="katex">x</span>`,
      width: 60,
      height: 20,
    })
    const side = 60 + FORMULA_PADDING * 2
    const tall = 20 + FORMULA_PADDING * 2
    expect(svg).toContain(`width="${side}"`)
    expect(svg).toContain(`height="${tall}"`)
    expect(svg).toContain(`viewBox="0 0 ${side} ${tall}"`)
    expect(svg).toContain(`<foreignObject x="0" y="0" width="${side}" height="${tall}">`)
    // The XHTML namespace is what makes the children render at all inside an SVG document.
    expect(svg).toContain(`<div xmlns="${XHTML_NS}"`)
    // Formulae are always rasterized light-on-white: a dark theme must not paste white-on-white.
    expect(svg).toContain('background:#ffffff')
    expect(svg).toContain('color:#000000')
    expect(svg).toContain('class="katex"')
  })

  it('rounds fractional measurements up so the bitmap never clips a glyph', () => {
    const svg = buildFormulaSvg({ html: 'x', width: 10.2, height: 1.5 })
    expect(svg).toContain('width="27"') // ceil(10.2 + 16)
    expect(svg).toContain('height="18"') // ceil(1.5 + 16)
  })

  it('appends the inlined font CSS and honours a custom padding', () => {
    const svg = buildFormulaSvg({
      html: 'x',
      width: 10,
      height: 10,
      fontCss: '@font-face{font-family:KaTeX_Main}',
      padding: 0,
    })
    expect(svg).toContain('<style>')
    expect(svg).toContain('@font-face{font-family:KaTeX_Main}')
    expect(svg).toContain('width="10"')
    expect(svg).toContain('padding:0px')
  })
})

describe('stripFontFaces', () => {
  it('removes @font-face blocks, which cannot load inside an SVG-as-image', () => {
    const css = '@font-face{font-family:K;src:url(fonts/K.woff2)}.katex{color:#000}'
    expect(stripFontFaces(css)).toBe('.katex{color:#000}')
  })

  it('leaves a stylesheet without faces untouched', () => {
    expect(stripFontFaces('.katex{font-size:1.21em}')).toBe('.katex{font-size:1.21em}')
  })
})

describe('katexFontFaceCss', () => {
  it('inlines every KaTeX face as a data: URL and caches the result', async () => {
    setStyleSheets([
      {
        cssRules: [
          fontFaceRule(
            'KaTeX_Main',
            '@font-face{font-family:KaTeX_Main;src:url("./KaTeX_Main-Regular.woff2") format("woff2")}',
          ),
        ],
      },
    ])
    const css = await katexFontFaceCss()
    // 'QUI=' is base64('AB') — the fetched bytes, inlined into src.
    expect(css).toContain('src:url("data:font/woff2;base64,QUI=") format("woff2")')
    expect(css).toContain('font-family:KaTeX_Main')
    expect(css).not.toContain('KaTeX_Main-Regular.woff2')
    expect(fetch).toHaveBeenCalledTimes(1)

    await katexFontFaceCss()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves a font url against the STYLESHEET, not the document (the packaged build)', async () => {
    // Vite emits `assets/index-*.css` next to `assets/KaTeX_*.woff2`; resolving against
    // `location.href` pointed one directory up, where no such file exists. The packaged build
    // fetches over file://, so a wrong base fails silently there and only there (e2e runs the
    // dev server, where the CSS is an inline <style>).
    const sheet = Object.assign(
      {
        cssRules: [
          fontFaceRule(
            'KaTeX_Main',
            '@font-face{font-family:KaTeX_Main;src:url("./KaTeX_Main-Regular.woff2") format("woff2")}',
          ),
        ],
      },
      { href: 'http://localhost/assets/index-abc.css' },
    )
    setStyleSheets([sheet])
    await katexFontFaceCss()
    expect(fetch).toHaveBeenCalledWith('http://localhost/assets/KaTeX_Main-Regular.woff2')
  })

  it('skips non-KaTeX families, other rule kinds and inaccessible stylesheets', async () => {
    setStyleSheets([
      {
        cssRules: [
          { type: 1, cssText: '.a{}', style: { getPropertyValue: () => 'Inter' } },
          fontFaceRule('Inter', '@font-face{font-family:Inter;src:url("./i.woff2")}'),
        ],
      },
      {
        get cssRules() {
          throw new Error('cross-origin')
        },
      },
    ])
    expect(await katexFontFaceCss()).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips a face whose cssText carries no url', async () => {
    setStyleSheets([
      { cssRules: [fontFaceRule('KaTeX_Main', '@font-face{font-family:KaTeX_Main}')] },
    ])
    expect(await katexFontFaceCss()).toBe('')
  })

  it('skips a face the fetch cannot deliver (and does not cache the failure)', async () => {
    const face = fontFaceRule(
      'KaTeX_Main',
      '@font-face{font-family:KaTeX_Main;src:url("./K.woff2") format("woff2")}',
    )
    setStyleSheets([{ cssRules: [face] }])

    stubFetch(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }))
    expect(await katexFontFaceCss()).toBe('')

    stubFetch(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }))
    expect(await katexFontFaceCss()).toBe('')

    stubFetch(async () => {
      throw new Error('offline')
    })
    expect(await katexFontFaceCss()).toBe('')
  })
})

describe('fontSizeOf', () => {
  it('reads the size the formula was rendered at', () => {
    document.body.innerHTML = '<span class="katex" style="font-size:18px">x</span>'
    expect(fontSizeOf(document.querySelector('.katex') as Element)).toBe('18px')
  })

  it('falls back to the default text size when the computed value is empty', () => {
    const el = document.createElement('span')
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ fontSize: '' } as CSSStyleDeclaration)
    expect(fontSizeOf(el)).toBe('16px')
  })
})

describe('measureTightBox', () => {
  const rect = (width: number, height: number) => ({ width, height }) as DOMRect

  it('re-flows the node in an inline-block wrapper to get its TIGHT content bounds', () => {
    const el = mountKatex(FULL_KATEX)
    // The wrapper div is the only div `createElement('div')` makes here; fake its rendered size.
    const orig = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
      opts?: ElementCreationOptions,
    ) => {
      const node = orig(tag, opts)
      if (tag === 'div') vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect(120, 40))
      return node
    }) as typeof document.createElement)
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      fontSize: '16px',
    } as CSSStyleDeclaration)
    expect(measureTightBox(el)).toEqual({ width: 120, height: 40 })
  })
})

// The off-screen measurement is the seam here: only `createElement('div')` is used to build the
// inline-block wrapper, so faking that div's size drives the whole path (a `vi.spyOn` on the
// module-level function would be a no-op — ESM live bindings).
function stubMeasure(width: number, height: number): void {
  const orig = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    opts?: ElementCreationOptions,
  ) => {
    const node = orig(tag, opts)
    if (tag === 'div')
      vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ width, height } as DOMRect)
    return node
  }) as typeof document.createElement)
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ fontSize: '16px' } as CSSStyleDeclaration)
}

describe('formulaToPng', () => {
  it('serializes the formula without its MathML branch and rasterizes it light at 2×', async () => {
    const spy = vi
      .spyOn(rasterize, 'svgToPngDataUrl')
      .mockResolvedValue('data:image/png;base64,FORMULA')
    stubMeasure(60, 20)
    const el = mountKatex(FULL_KATEX)

    expect(await formulaToPng(el)).toBe('data:image/png;base64,FORMULA')
    const [svg, opts] = spy.mock.calls[0]
    // The visual branch is what gets drawn…
    expect(svg).toContain('katex-html')
    // …while the MathML branch would render as its own text inside a bitmap.
    expect(svg).not.toContain('katex-mathml')
    expect(svg).toMatch(/font-size:\s*16px/)
    expect(opts).toEqual({ background: '#ffffff', scale: FORMULA_SCALE })
  })

  it('uses the TIGHT content box for sizing, not the element box', async () => {
    // A block-level `.katex` inside `.katex-display` spans the whole preview (e.g. 2257px wide),
    // with the glyphs centred — its own box must NOT become the bitmap width.
    const spy = vi
      .spyOn(rasterize, 'svgToPngDataUrl')
      .mockResolvedValue('data:image/png;base64,FORMULA')
    stubMeasure(180, 51)
    const el = mountKatex(FULL_KATEX)

    await formulaToPng(el)
    const [svg] = spy.mock.calls[0]
    const side = 180 + FORMULA_PADDING * 2
    const tall = 51 + FORMULA_PADDING * 2
    expect(svg).toContain(`width="${side}"`)
    expect(svg).toContain(`height="${tall}"`)
  })

  it('handles a formula with no MathML branch at all', async () => {
    const spy = vi
      .spyOn(rasterize, 'svgToPngDataUrl')
      .mockResolvedValue('data:image/png;base64:FORMULA')
    stubMeasure(30, 20)
    const el = mountKatex('<span class="katex-html">x</span>')

    expect(await formulaToPng(el)).toBe('data:image/png;base64:FORMULA')
    expect(spy.mock.calls[0][0]).toContain('katex-html')
  })

  it('returns null for a zero-sized element (nothing to rasterize)', async () => {
    stubMeasure(0, 20)
    expect(await formulaToPng(mountKatex(FULL_KATEX))).toBeNull()

    stubMeasure(60, 0)
    expect(await formulaToPng(mountKatex(FULL_KATEX))).toBeNull()
  })

  it('returns null when the rasterization rejects (the menu then copies nothing)', async () => {
    vi.spyOn(rasterize, 'svgToPngDataUrl').mockRejectedValue(new Error('no canvas'))
    stubMeasure(60, 20)
    expect(await formulaToPng(mountKatex(FULL_KATEX))).toBeNull()
  })
})
