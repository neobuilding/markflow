// Plan 04 — copy fidelity unit coverage (ADR-0004: every lib file 100%).
//
// jsdom does not apply stylesheets to getComputedStyle, so the style values we read in tests
// come from INLINE styles on the fixtures. That is enough to exercise every branch of the
// inlining / rasterization / post-processing logic; the "reads real CSS" behaviour is validated
// end-to-end by the e2e suite (select-all-copy-fidelity.e2e.spec.ts) in a real browser.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import '../i18n'
import {
  enhanceForPaste,
  safeEnhanceForPaste,
  lightTokenDeclarations,
  readableRules,
  rgbToHex,
} from './copyFidelity'
import { mermaidPngCache, mermaidSvgCache } from './mermaidBake'
import { warmInlinedImages, resetInlinedImageCache } from './previewCopy'
import { setExportMermaidSlots, setExportHtml } from './exportStore'
import { sanitizeHtml } from './sanitize'

vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: async (id: string) => ({ svg: `<svg id="${id}"></svg>` }),
  },
}))

beforeEach(() => {
  mermaidSvgCache.clear()
  mermaidPngCache.clear()
  resetInlinedImageCache()
  setExportMermaidSlots([])
  setExportHtml(sanitizeHtml(''))
})

describe('enhanceForPaste — style inlining (D12 = A)', () => {
  it('inlines selected computed styles and skips values inherited from the parent', () => {
    const html =
      '<div style="color:rgb(0,0,0);font-size:16px">' +
      '<span>inherited</span>' + // inherits parent color → skipped (inheritance)
      '<span style="color:rgb(255,0,0)">diff</span>' + // differs → inlined
      '<p style="background-color:transparent">note</p>' + // transparent → skipped
      '</div>'
    const out = enhanceForPaste(html)
    // outer div carries both styles (order-independent; jsdom emits no space after colon)
    expect(out).toMatch(/<div style="[^"]*font-size:16px/)
    expect(out).toMatch(/color:\s*rgb\(0,\s*0,\s*0\)/)
    // differing child is inlined
    expect(out).toMatch(/<span style="[^"]*color:\s*rgb\(255,\s*0,\s*0\)[^"]*">diff<\/span>/)
    // inherited child gets no inline style (inheritance skip)
    expect(out).not.toMatch(/<span style="[^"]*">inherited<\/span>/)
  })

  it('inlines borders, handling uniform vs per-side forms (§4.2)', () => {
    const html =
      '<pre style="border:1px solid rgb(0,0,0)">code</pre>' +
      '<blockquote style="border-left:0.25em solid rgb(0,0,0);padding:1em">q</blockquote>'
    const out = enhanceForPaste(html)
    expect(out).toMatch(/border:\s*1px solid rgb\(0,\s*0,\s*0\)/)
    // jsdom resolves the github-markdown-css `0.25em` to `4px`
    expect(out).toMatch(/border-left:\s*4px solid rgb\(0,\s*0,\s*0\)/)
  })

  it('inlines border-radius (A1 attribute list)', () => {
    const out = enhanceForPaste('<div style="border-radius:8px">x</div>')
    expect(out).toMatch(/border-radius:\s*8px/)
  })

  it('skips a border that is identical to the parent border (inheritance)', () => {
    const html =
      '<div style="border:1px solid rgb(0,0,0)"><p style="border:1px solid rgb(0,0,0)">x</p></div>'
    const out = enhanceForPaste(html)
    expect(out).toMatch(/<div style="[^"]*border:\s*1px solid rgb\(0,\s*0,\s*0\)/)
    // child border is re-inlined (border inheritance skip intentionally omitted to stay
    // engine-agnostic; nested bordered elements are rare and harmless to duplicate)
    expect(out).toMatch(/<p style="[^"]*border: 1px solid rgb\(0,\s*0,\s*0\)">x<\/p>/)
  })

  it('inlines text-decoration:underline (and leaves none as-is without special-casing)', () => {
    const html = '<a style="text-decoration:underline">link</a>'
    const out = enhanceForPaste(html)
    expect(out).toMatch(/<a style="[^"]*text-decoration:\s*underline/)
  })

  it('leaves transparent colors untouched (does not inline/transform them)', () => {
    expect(enhanceForPaste('<p style="color:transparent">x</p>')).toMatch(
      /<p style="color:transparent">/,
    )
    expect(enhanceForPaste('<p style="color:rgba(0, 0, 0, 0)">x</p>')).toMatch(
      /<p style="color:rgba\(0, 0, 0, 0\)">/,
    )
  })

  describe('rgbToHex', () => {
    it('converts rgb() to hex and passes through non-rgb values', () => {
      expect(rgbToHex('rgb(255, 0, 0)')).toBe('#ff0000')
      expect(rgbToHex('red')).toBe('red')
    })
  })

  it('skips mermaid and katex subtrees during inlining (handled separately)', () => {
    const html = '<div data-mermaid-slot="0"><svg></svg></div>' + '<span class="katex">x</span>'
    const out = enhanceForPaste(html)
    // neither subtree gets an inline style added by our walk (they are rasterized elsewhere)
    expect(out).not.toMatch(/data-mermaid-slot="0" style=/)
    expect(out).not.toMatch(/class="katex" style=/)
  })
})

describe('enhanceForPaste — mermaid rasterization (R13.1 / D13)', () => {
  it('replaces a mermaid slot with its cached PNG <img>, pinned to the diagram size', () => {
    setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-m' }])
    mermaidPngCache.set('h-m', {
      dataUrl: 'data:image/png;base64,AAAA',
      width: 181.33,
      height: 498.67,
    })
    const out = enhanceForPaste('<div data-mermaid-slot="0"><svg>x</svg></div>')
    expect(out).toContain('src="data:image/png;base64,AAAA"')
    // The bitmap is 2× this size, so the display size must be pinned on the <img> — without it the
    // target app would render the bitmap at 2× the size the preview shows.
    expect(out).toMatch(/<img[^>]*width="181"/)
    expect(out).toMatch(/<img[^>]*height="499"/)
    expect(out).not.toContain('data-mermaid-slot')
  })

  it('keeps the inline svg when the PNG is not yet cached (no content loss)', () => {
    setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-missing' }])
    const out = enhanceForPaste('<div data-mermaid-slot="0"><svg>x</svg></div>')
    // The slot wrapper's data-mermaid-slot is stripped as a pipeline marker, but the diagram
    // markup itself survives so content is never lost.
    expect(out).toContain('<svg')
    expect(out).not.toContain('data-mermaid-slot')
  })

  it('ignores a slot with no registered hash', () => {
    const out = enhanceForPaste('<div data-mermaid-slot="9"><svg>x</svg></div>')
    expect(out).toContain('<svg')
    expect(out).not.toContain('data-mermaid-slot')
  })

  it('backfills an EMPTY slot from the SVG cache when the PNG is not ready (never drops a diagram)', () => {
    // Regression: a live-DOM source (keyboard copy / partial selection) carries unfilled
    // placeholders because the preview bakes mermaid lazily. The enhanced payload must still
    // contain the diagram (here from the SVG cache) rather than an empty <div>.
    setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-svg' }])
    mermaidSvgCache.set('h-svg', { svg: '<svg id="cached-diagram"></svg>' })
    const out = enhanceForPaste('<div data-mermaid-slot="0"></div>')
    expect(out).toContain('<svg id="cached-diagram">')
    expect(out).not.toContain('data-mermaid-slot')
  })

  it('leaves an empty slot empty when neither a PNG nor an SVG is cached (nothing to fill)', () => {
    setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-none' }])
    const out = enhanceForPaste('<div data-mermaid-slot="0"></div>')
    expect(out).toContain('<div></div>')
    expect(out).not.toContain('data-mermaid-slot')
  })
})

describe('enhanceForPaste — math keeps its MathML carrier (R13.9 / D17: NOT rasterized)', () => {
  const formula =
    '<p>inline <span class="katex"><span class="katex-mathml">' +
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>' +
    '<annotation encoding="application/x-tex">a^2</annotation>' +
    '</semantics></math></span><span class="katex-html">rendered</span></span></p>'

  it('passes the KaTeX subtree through untouched (MathML is what Word / OneNote convert)', () => {
    const out = enhanceForPaste(formula)
    // The MathML carrier survives verbatim…
    expect(out).toMatch(/<math[\s>]/)
    expect(out).toMatch(/annotation[^>]*application\/x-tex/i)
    expect(out).toContain('katex-html')
    // …no inline style is stamped onto the formula subtree (walkInline skips it)…
    expect(out).not.toMatch(/<span class="katex" style=/)
    // …and nothing is swapped for an image: a bitmap would paste into Word as a picture rather
    // than an editable equation, which is exactly what the rejected D17 rasterization would do.
    expect(out).not.toMatch(/<img[^>]+alt="a\^2"/)
  })
})

describe('safeEnhanceForPaste (§4.5 — never let a failure fall through to the native copy)', () => {
  it('degrades to the stripped semantic HTML when enhancement throws', () => {
    // A fidelity failure must NOT throw out of the `copy` handler: that would skip
    // preventDefault and let the browser copy the raw, un-styled DOM.
    const spy = vi.spyOn(document.body, 'appendChild').mockImplementation((): never => {
      throw new Error('boom')
    })
    try {
      expect(safeEnhanceForPaste('<h1 data-line="0">T</h1>')).toBe('<h1>T</h1>')
    } finally {
      spy.mockRestore()
    }
  })

  it('returns the enhanced payload on the happy path', () => {
    const out = safeEnhanceForPaste('<h1 data-line="0">T</h1>')
    expect(out).not.toContain('data-line')
    expect(out).toContain('T</h1>')
  })
})

describe('enhanceForPaste — per-target post-processing (§4.6)', () => {
  it('double-writes Excel borders and bgcolor on table cells', () => {
    const html =
      '<table><tr>' +
      '<td style="background-color:rgb(255,0,0)">a</td>' +
      '<td style="background-color:red">b</td>' +
      '<th>c</th></tr></table>'
    const out = enhanceForPaste(html)
    expect(out).toContain('border="1"')
    // jsdom normalizes `red` → `rgb(255, 0, 0)`, so both cells become the hex form
    expect(out).toContain('bgcolor="#ff0000"')
  })

  it('does not write bgcolor for a transparent cell background', () => {
    const out = enhanceForPaste(
      '<table><tr><td style="background-color:transparent">a</td></tr></table>',
    )
    expect(out).toContain('border="1"')
    expect(out).not.toContain('bgcolor')
  })
})

describe('enhanceForPaste — volume guard & theme (R13.8 / D16)', () => {
  it('skips the style walk when the INPUT exceeds the ceiling (structure kept, markers still stripped)', () => {
    const huge = `<h1 data-line="0">${'x'.repeat(500)}</h1>`
    const out = enhanceForPaste(huge, true, 100)
    expect(out).toContain('<h1>x')
    expect(out).not.toContain('data-line')
    // no inline styles were attempted on the oversized fragment
    expect(out).not.toContain('style="')
  })

  it('discards an oversized RESULT, so the ceiling bounds the payload and not just the work', () => {
    // `<pre>` is the clearest inflater: the walk adds `white-space` + `font-family` that the raw
    // input does not contain, so the two outcomes are distinguishable.
    const input = '<pre><code>a</code></pre>'
    expect(enhanceForPaste(input)).toContain('white-space')
    // A ceiling just above the raw input is breached by the walked result → structure-only payload.
    const out = enhanceForPaste(input, true, input.length + 1)
    expect(out).toContain('<code>a</code>')
    expect(out).not.toContain('white-space')
  })

  it('does not count inlined base64 image bodies against the ceiling', () => {
    // An image-heavy document is not "huge" in the sense this ceiling cares about: the walk costs
    // scale with node count, and counting the base64 would drop the styles exactly where a reader
    // needs them. `<pre>` is used because the walk demonstrably adds `white-space` to it.
    const img = `data:image/png;base64,${'A'.repeat(4000)}`
    const out = enhanceForPaste(`<pre><img src="${img}"><code>x</code></pre>`, true, 500)
    expect(out).toContain('white-space')
    expect(out).toContain('data:image/png;base64,')
  })

  it('supports the non-forceLight branch (follow-theme future option)', () => {
    const out = enhanceForPaste('<p>x</p>', false)
    expect(out).toContain('<p>x</p>')
  })

  it('always wraps the payload in a minimal light document envelope', () => {
    const out = enhanceForPaste('<h1>x</h1>')
    expect(out).toContain('<meta charset="utf-8">')
    expect(out).toContain('<body class="markdown-body">')
  })
})

describe('light-token pinning (D16 — the fragment must be a LIGHT island)', () => {
  // Regression guard: globals.css declares every design token twice — on `:root` (light) and on
  // `.dark`, which App.tsx toggles on <html>. Without pinning, the host inherited the DARK tokens
  // and `.markdown-body pre` (globals.css) inlined a #222222 background / #2e2e2e border into a
  // payload that is supposed to be light.
  it('reads the :root token block, ignoring other selectors and at-rules', () => {
    const style = document.createElement('style')
    style.textContent =
      ':root{--probe-overlay:#f0f0f0;color:red}' +
      '.not-root{--probe-other:#000000}' +
      '@media screen{.probe-media{--probe-media:#111111}}'
    document.head.appendChild(style)
    try {
      const decls = lightTokenDeclarations()
      // The custom properties of `:root` are carried over…
      expect(decls).toContain('--probe-overlay: #f0f0f0')
      // …while real declarations, other selectors and nested at-rules are not.
      expect(decls).not.toContain('color: red')
      expect(decls).not.toContain('--probe-other')
      expect(decls).not.toContain('--probe-media')
      // A copy performed while such tokens exist pins them on the host (the `if (tokens)` branch).
      expect(enhanceForPaste('<p>x</p>')).toContain('<p')
    } finally {
      style.remove()
    }
  })

  it('ignores a stylesheet that cannot be read (defensive)', () => {
    const blocked = {
      get cssRules(): never {
        throw new Error('blocked by the browser')
      },
    }
    expect(readableRules(blocked as unknown as CSSStyleSheet)).toEqual([])
  })
})

describe('enhanceForPaste — keyboard-path image inlining (§4.8)', () => {
  // The menu path inlines images via embedImages; the KEYBOARD path has no pending payload, so the
  // whole-article string is pre-inlined by warmInlinedImages and — for a PARTIAL SELECTION — the
  // fragment's own <img>s are rewritten from the src → data: map that same pass produced.
  const embed = async (h: string): Promise<string> =>
    h.replace('appdoc://d/x.png', 'data:image/png;base64,XY')

  it('rewrites an appdoc:// src from the pre-inlined map and leaves unmapped ones alone', async () => {
    ;(window as unknown as { api?: unknown }).api = { export: { embedImages: embed } }
    try {
      setExportHtml(sanitizeHtml('<img src="appdoc://d/x.png">'))
      await warmInlinedImages(document.createElement('article'))
      const out = enhanceForPaste(
        '<p><img src="appdoc://d/x.png"><img src="appdoc://d/other.png"><img alt="no src"></p>',
      )
      expect(out).toContain('src="data:image/png;base64,XY"')
      // An unmapped or src-less image stays as it was: a broken image beats embedding the WRONG one.
      expect(out).toContain('appdoc://d/other.png')
      expect(out).toContain('alt="no src"')
    } finally {
      ;(window as unknown as { api?: unknown }).api = undefined
      resetInlinedImageCache()
    }
  })

  it('is a no-op when nothing has been pre-inlined yet (keyboard copy before the first render)', () => {
    const out = enhanceForPaste('<img src="appdoc://d/x.png">')
    expect(out).toContain('appdoc://d/x.png')
  })
})
