// ADR 0019 — the copy path must carry the diagrams too.
//
// The preview bakes mermaid lazily (D-E①), so the canonical export HTML it hands to copy
// starts out as EMPTY placeholders. `requestRichCopy` completes it first (async, menu path);
// the keyboard path cannot await and relies on the preview's background pass having already
// completed the same cache. Either way `buildPreviewCopyPayload` reads a complete string.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import '../i18n'
import {
  buildPreviewCopyPayload,
  stripInternalAttrs,
  requestRichCopy,
  warmInlinedImages,
  resetInlinedImageCache,
  getInlinedImageMap,
  deferColdCopy,
  deferWarmCopy,
  consumePendingCopy,
} from './previewCopy'
import { setExportHtml, setExportMermaidSlots, getExportHtml } from './exportStore'
import { prepareExportHtml, resetExportBake } from './exportBake'
import { sanitizeHtml } from './sanitize'
import { mermaidSvgCache, mermaidPngCache } from './mermaidBake'
import { safeEnhanceForPaste } from './copyFidelity'

vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: async (id: string) => ({ svg: `<svg id="${id}"><rect/></svg>` }),
  },
}))

// Canvas rasterization cannot run under jsdom, so `rasterizeSvg` is mocked: prepareExportHtml
// (which requestRichCopy / warmInlinedImages await) now awaits it.
vi.mock('./rasterize', () => ({
  svgDataUrl: (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  RASTER_SCALE: 2,
  MAX_RASTER_EDGE: 2000,
  svgIntrinsicSize: () => ({ width: 181, height: 499 }),
  rasterPixelSize: (s: { width: number; height: number }) => ({
    width: s.width * 2,
    height: s.height * 2,
  }),
  rasterizeSvg: vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,MOCKPNG',
    width: 181,
    height: 499,
  })),
  svgToPngDataUrl: vi.fn(async () => 'data:image/png;base64,MOCKPNG'),
}))

const slots = [{ slot: 0, code: 'graph TD;A-->B', hash: 'h-copy' }]

beforeEach(() => {
  mermaidSvgCache.clear()
  resetExportBake()
  setExportMermaidSlots([])
  setExportHtml(sanitizeHtml(''))
})

function article(): HTMLElement {
  const el = document.createElement('article')
  el.className = 'markdown-preview'
  // Deliberately STALE: the whole-article branch must prefer the canonical export HTML
  // over scraping the live DOM (contract #2).
  el.innerHTML = '<p>stale dom</p>'
  document.body.appendChild(el)
  return el
}

describe('whole-article copy payload (ADR 0019)', () => {
  it('carries the baked mermaid svg instead of an empty placeholder', async () => {
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml('<div data-mermaid-slot="0" data-line="0"></div>'))
    // What requestRichCopy does before building the payload (menu path).
    await prepareExportHtml()

    const { html, text } = buildPreviewCopyPayload(article())
    expect(html).toContain('<svg')
    expect(html).not.toContain('<p>stale dom</p>')
    // buildPreviewCopyPayload now returns UN-STRIPPED html (the fidelity layer strips
    // internal markers as its final step), so the slots/markers are still present here.
    expect(html).toContain('data-mermaid-slot')
    expect(html).toContain('data-line')
    expect(text).not.toContain('stale dom')
  })

  it('copies only the live selection when one exists inside the preview', () => {
    const a = article()
    const p = document.createElement('p')
    p.textContent = 'sel'
    a.appendChild(p)
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    try {
      const { html, text } = buildPreviewCopyPayload(a)
      expect(html).toContain('sel')
      expect(text).toBe('sel')
    } finally {
      sel.removeAllRanges()
    }
  })

  it('completes a pending bake before building the menu-path payload (ADR 0019)', async () => {
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml('<div data-mermaid-slot="0"></div>'))
    // The component suite mocks requestRichCopy; this drives the REAL one, which is where
    // the "do I need to bake first?" branch lives.
    await requestRichCopy(article())
    expect(getExportHtml()).toContain('<svg')
    const { html } = buildPreviewCopyPayload(article())
    expect(html).toContain('<svg')
  })

  it('strips internal markers but keeps the svg markup', () => {
    const cleaned = stripInternalAttrs(
      '<div data-mermaid-slot="0" data-line="3" data-baked="1"><svg id="m"></svg></div>',
    )
    expect(cleaned).toContain('<svg')
    expect(cleaned).not.toContain('data-mermaid-slot')
    expect(cleaned).not.toContain('data-line')
    expect(cleaned).not.toContain('data-baked')
  })

  describe('inlined-image cache (§4.8 keyboard path parity)', () => {
    it('pre-inlines from the BAKED canonical, not the lazy live DOM (keeps off-screen diagrams)', async () => {
      // Regression (plan-04): the cache used to be built from `article.innerHTML`, which has
      // EMPTY placeholders for off-screen diagrams (the preview bakes lazily). Because the
      // whole-article branch prefers this cache, every diagram was dropped on paste.
      const embed = vi.fn(async (h: string) => h.replace(/appdoc:\/\//g, 'data:'))
      ;(window as unknown as { api?: unknown }).api = { export: { embedImages: embed } }
      try {
        setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-baked' }])
        setExportHtml(sanitizeHtml('<div data-mermaid-slot="0"></div><img src="appdoc://d/x.png">'))
        const a = article()
        a.innerHTML = '<div data-mermaid-slot="0"></div><img src="appdoc://d/x.png">'
        await warmInlinedImages(a)
        // It must bake FIRST, so the source handed to embedImages carries the diagram.
        expect(embed).toHaveBeenCalledWith(expect.stringContaining('<svg'))
        const { html } = buildPreviewCopyPayload(a)
        expect(html).toContain('<svg')
        expect(html).not.toContain('<div data-mermaid-slot="0"></div>')
      } finally {
        ;(window as unknown as { api?: unknown }).api = undefined
        resetInlinedImageCache()
      }
    })

    it('prefers the pre-inlined image cache for the whole-article path', async () => {
      const api = {
        export: {
          embedImages: vi.fn(async (h: string) => h.replace(/appdoc:\/\//g, 'data:')),
        },
      }
      ;(window as unknown as { api?: unknown }).api = api
      try {
        setExportHtml(sanitizeHtml('<img src="appdoc://d/x.png">'))
        const a = article()
        a.innerHTML = '<img src="appdoc://d/x.png">'
        await warmInlinedImages(a)
        const { html } = buildPreviewCopyPayload(a)
        expect(html).toContain('data:')
        expect(html).not.toContain('appdoc://')
        expect(api.export.embedImages).toHaveBeenCalled()
      } finally {
        ;(window as unknown as { api?: unknown }).api = undefined
        resetInlinedImageCache()
      }
    })

    it('skips inlining when the embed IPC is unavailable', async () => {
      const a = article()
      a.innerHTML = '<img src="appdoc://d/x.png">'
      await warmInlinedImages(a)
      // No api → cache stays empty → whole-article falls back to the canonical html.
      setExportHtml(sanitizeHtml('<img src="appdoc://d/x.png">'))
      const { html } = buildPreviewCopyPayload(a)
      expect(html).toContain('appdoc://')
    })

    it('does not call embedImages when the article has no images', async () => {
      const embed = vi.fn()
      ;(window as unknown as { api?: unknown }).api = { export: { embedImages: embed } }
      try {
        const a = article()
        await warmInlinedImages(a)
        expect(embed).not.toHaveBeenCalled()
      } finally {
        ;(window as unknown as { api?: unknown }).api = undefined
        resetInlinedImageCache()
      }
    })

    it('also records the src → data: map, so a PARTIAL selection can be inlined (§4.8)', async () => {
      const embed = vi.fn(async (h: string) =>
        h.replace('appdoc://d/x.png', 'data:image/png;base64,XY'),
      )
      ;(window as unknown as { api?: unknown }).api = { export: { embedImages: embed } }
      try {
        setExportHtml(
          sanitizeHtml(
            '<img src="appdoc://d/x.png"><img src="appdoc://d/not-inlined.png">' +
              '<img src="data:image/png;base64,OLD"><img alt="no src">',
          ),
        )
        await warmInlinedImages(article())
        const map = getInlinedImageMap()
        expect(map.get('appdoc://d/x.png')).toBe('data:image/png;base64,XY')
        // Nothing else is mapped: an image that was NOT inlined (still appdoc://), one that is
        // already a data: URL, and a src-less one all stay out of the map.
        expect(map.has('appdoc://d/not-inlined.png')).toBe(false)
        expect(map.has('data:image/png;base64,OLD')).toBe(false)
        expect(map.has('')).toBe(false)
        // The reset honoured by the copy layer clears the map together with the payload cache.
        resetInlinedImageCache()
        expect(getInlinedImageMap().size).toBe(0)
      } finally {
        ;(window as unknown as { api?: unknown }).api = undefined
        resetInlinedImageCache()
      }
    })

    it('keeps both caches empty when image inlining fails (embed IPC rejects)', async () => {
      const api = { export: { embedImages: vi.fn().mockRejectedValue(new Error('boom')) } }
      ;(window as unknown as { api?: unknown }).api = api
      try {
        setExportHtml(sanitizeHtml('<img src="appdoc://d/x.png">'))
        await warmInlinedImages(article())
        // The whole-article path falls back to the baked canonical (un-inlined src)…
        const { html } = buildPreviewCopyPayload(article())
        expect(html).toContain('appdoc://')
        // …and no src → data: mapping exists, so a SELECTION copy can never embed a wrong picture.
        expect(getInlinedImageMap().size).toBe(0)
      } finally {
        ;(window as unknown as { api?: unknown }).api = undefined
        resetInlinedImageCache()
      }
    })

    it('drops the whole map when the inlined HTML has a different <img> count', async () => {
      // Shape mismatch (should not happen with the real handler) must never pair image A with the
      // data URL of image B — the copy degrades to un-inlined images instead.
      const embed = vi.fn(async () => '<img src="data:image/png;base64,ONLY">')
      ;(window as unknown as { api?: unknown }).api = { export: { embedImages: embed } }
      try {
        setExportHtml(sanitizeHtml('<img src="appdoc://d/a.png"><img src="appdoc://d/b.png">'))
        await warmInlinedImages(article())
        expect(getInlinedImageMap().size).toBe(0)
      } finally {
        ;(window as unknown as { api?: unknown }).api = undefined
        resetInlinedImageCache()
      }
    })
  })

  describe('menu-path image inlining (R13.7)', () => {
    it('inlines <img> on the menu path when present', async () => {
      const api = {
        export: {
          embedImages: vi.fn(async (h: string) => h.replace(/appdoc:\/\//g, 'data:')),
        },
      }
      ;(window as unknown as { api?: unknown }).api = api
      try {
        setExportMermaidSlots([])
        setExportHtml(sanitizeHtml('<p><img src="appdoc://d/x.png"></p>'))
        await requestRichCopy(article())
        expect(api.export.embedImages).toHaveBeenCalled()
      } finally {
        ;(window as unknown as { api?: unknown }).api = undefined
      }
    })

    it('keeps the un-inlined html when image inlining fails (menu path)', async () => {
      const api = {
        export: { embedImages: vi.fn().mockRejectedValue(new Error('boom')) },
      }
      ;(window as unknown as { api?: unknown }).api = api
      try {
        setExportMermaidSlots([])
        setExportHtml(sanitizeHtml('<p><img src="appdoc://d/x.png"></p>'))
        await requestRichCopy(article())
        expect(api.export.embedImages).toHaveBeenCalled()
      } finally {
        ;(window as unknown as { api?: unknown }).api = undefined
      }
    })
  })

  // D — cold-cache copy retry (fixes "the first copy drops diagrams"). The `copy` event is
  // synchronous and cannot await PNG rasterization; when the bake isn't ready the handler defers,
  // finishes the bake, REBUILDS the payload and re-fires the native copy. These tests drive that
  // contract directly (the component's onCopy delegates to deferColdCopy / deferWarmCopy).
  describe('cold-cache copy retry (fixes first-copy drops diagrams)', () => {
    let realExecCommand: typeof document.execCommand

    beforeEach(() => {
      realExecCommand = document.execCommand
    })
    afterEach(() => {
      document.execCommand = realExecCommand
    })

    it('defers once, blocks a second defer (no infinite loop), then the bake warms the cache', async () => {
      setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-cold' }])
      setExportHtml(sanitizeHtml('<div data-mermaid-slot="0"></div>'))
      // Stand in execCommand (jsdom has none): it must dispatch the same kind of copy event the
      // real one produces; the listener mirrors the component's fast path.
      const host = document.createElement('article')
      const setData = vi.fn()
      host.addEventListener('copy', (e) => {
        const payload = consumePendingCopy()
        if (!payload) return
        e.clipboardData?.setData('text/html', safeEnhanceForPaste(payload.html))
        e.preventDefault()
      })
      document.execCommand = vi.fn((cmd) => {
        if (cmd === 'copy') {
          const ev = new Event('copy', { bubbles: true, cancelable: true })
          Object.defineProperty(ev, 'clipboardData', { value: { setData } })
          host.dispatchEvent(ev)
        }
        return true
      }) as typeof document.execCommand

      const payload = { text: 'x', html: '<div data-mermaid-slot="0"></div>' }
      expect(deferColdCopy(host, payload)).toBe(true)
      // A re-entrant call (the re-fired copy event) must NOT defer again — else a loop.
      expect(deferColdCopy(host, payload)).toBe(false)

      await vi.waitFor(() =>
        expect(setData).toHaveBeenCalledWith(
          'text/html',
          expect.stringContaining('data:image/png;base64,MOCKPNG'),
        ),
      )
      // The rebuilt payload carried the diagram and the warm cache let the fidelity layer swap it
      // for the PNG — exactly what the deferred fast path must produce.
      expect(mermaidPngCache.get('h-cold')?.dataUrl).toBe('data:image/png;base64,MOCKPNG')
      // Once the PNG is cached the payload awaits nothing, so no further copy is deferred.
      expect(deferColdCopy(host, payload)).toBe(false)
    })

    it('still copies something on the cold path even when rasterization cannot run', async () => {
      // If PNG rasterization rejects, the diagram is backfilled from the SVG cache rather than
      // dropped — the deferred path must never ship an EMPTY placeholder.
      setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-cold2' }])
      setExportHtml(sanitizeHtml('<div data-mermaid-slot="0"></div>'))
      const host = document.createElement('article')
      const setData = vi.fn()
      host.addEventListener('copy', (e) => {
        const payload = consumePendingCopy()
        if (!payload) return
        e.clipboardData?.setData('text/html', safeEnhanceForPaste(payload.html))
        e.preventDefault()
      })
      const { rasterizeSvg } = await import('./rasterize')
      ;(rasterizeSvg as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no canvas'))
      document.execCommand = vi.fn((cmd) => {
        if (cmd === 'copy') {
          const ev = new Event('copy', { bubbles: true, cancelable: true })
          Object.defineProperty(ev, 'clipboardData', { value: { setData } })
          host.dispatchEvent(ev)
        }
        return true
      }) as typeof document.execCommand

      await deferWarmCopy(host)

      const written = (setData.mock.calls[0]?.[1] as string) ?? ''
      // No PNG was produced, so the SVG-cache backfill must still be present (content not lost).
      expect(written).toContain('<svg')
      expect(written).not.toContain('data-mermaid-slot')
    })

    it('swallows an execCommand failure so a denied copy never breaks the path', async () => {
      document.execCommand = vi.fn(() => {
        throw new Error('clipboard denied')
      }) as typeof document.execCommand
      await expect(deferWarmCopy(document.createElement('article'))).resolves.toBeUndefined()
    })

    it('completes the bake even when the environment has no execCommand', async () => {
      setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-noexec' }])
      setExportHtml(sanitizeHtml('<div data-mermaid-slot="0"></div>'))
      delete (document as { execCommand?: unknown }).execCommand
      await expect(deferWarmCopy(document.createElement('article'))).resolves.toBeUndefined()
      // The bake still ran, so the PNG cache is warm for a later real copy.
      expect(mermaidPngCache.get('h-noexec')?.dataUrl).toBe('data:image/png;base64,MOCKPNG')
    })

    it('does NOT defer a copy whose payload awaits no diagram (no needless wait)', () => {
      // A paragraph copy inside a 4-diagram document must not be held up behind a whole-document
      // rasterization: the decision is made on the PAYLOAD, not on "is the bake complete".
      setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-unused' }])
      document.execCommand = vi.fn(() => true) as typeof document.execCommand
      const payload = { text: 'just text', html: '<p>just text</p>' }
      expect(deferColdCopy(document.createElement('article'), payload)).toBe(false)
    })

    it('does NOT defer when execCommand is unavailable (never copies nothing)', () => {
      // Deferring here would silently write NOTHING at all, which is worse than the payload.
      setExportMermaidSlots([{ slot: 0, code: 'graph TD', hash: 'h-noexec2' }])
      delete (document as { execCommand?: unknown }).execCommand
      const payload = { text: 'x', html: '<div data-mermaid-slot="0"></div>' }
      expect(deferColdCopy(document.createElement('article'), payload)).toBe(false)
    })

    it('ignores a slot marker that is not in the parsed slot list', () => {
      // beforeEach resets the slots to [], so the marker has no hash to resolve — nothing to wait
      // for, therefore nothing is deferred.
      document.execCommand = vi.fn(() => true) as typeof document.execCommand
      const payload = { text: 'x', html: '<div data-mermaid-slot="7"></div>' }
      expect(deferColdCopy(document.createElement('article'), payload)).toBe(false)
    })
  })
})
