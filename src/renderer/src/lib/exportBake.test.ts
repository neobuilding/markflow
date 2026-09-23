import { describe, it, expect, beforeEach, vi } from 'vitest'
import '../i18n'
import {
  prepareExportHtml,
  needsExportBake,
  resetExportBake,
  scheduleExportBake,
} from './exportBake'
import { setExportHtml, setExportMermaidSlots, getExportHtml } from './exportStore'
import { sanitizeHtml } from './sanitize'
import { mermaidSvgCache, mermaidPngCache } from './mermaidBake'

// Same indirection as mermaidBake.test.ts so a test can make the render hang (to prove a
// re-parse that lands mid-bake is not clobbered by the stale result).
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: (...a: unknown[]) =>
      (globalThis as unknown as { __mermaidRender: (...x: unknown[]) => unknown }).__mermaidRender(
        ...a,
      ),
  },
}))

const renderMock = vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }))

// Canvas rasterization cannot run under jsdom, so the real `rasterizeSvg` is mocked. The bake
// must now await it; the mock resolves with a deterministic PNG entry.
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

const slots = [{ slot: 0, code: 'graph TD;A-->B', hash: 'h-eb' }]
const PLACEHOLDER = '<div data-mermaid-slot="0" data-line="0"></div>'

beforeEach(() => {
  ;(globalThis as unknown as { __mermaidRender: unknown }).__mermaidRender = renderMock
  // mockReset (not mockClear): a `mockImplementationOnce` left unconsumed by one test would
  // otherwise leak into the next one and hang it.
  renderMock.mockReset()
  renderMock.mockImplementation(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }))
  mermaidSvgCache.clear()
  resetExportBake()
  setExportMermaidSlots([])
  setExportHtml(sanitizeHtml(''))
})

describe('prepareExportHtml (ADR 0019)', () => {
  it('is a no-op when there is no document', async () => {
    await expect(prepareExportHtml()).resolves.toBe('')
  })

  it('is a no-op for a document without diagrams', async () => {
    setExportHtml(sanitizeHtml('<p>hi</p>'))
    await expect(prepareExportHtml()).resolves.toBe('<p>hi</p>')
    expect(needsExportBake()).toBe(false)
  })

  it('bakes every diagram into the canonical html and publishes it', async () => {
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml(PLACEHOLDER))
    expect(needsExportBake()).toBe(true)

    const out = await prepareExportHtml()
    expect(out).toContain('<svg')
    // Published: export / print / copy all read this one string.
    expect(getExportHtml()).toContain('<svg')
    // The wrapper keeps its slot marker (copy strips it later; export keeps the structure).
    expect(getExportHtml()).toContain('data-mermaid-slot="0"')
    expect(needsExportBake()).toBe(false)
  })

  it('awaits the diagram PNGs so the synchronous copy event finds them cached', async () => {
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml(PLACEHOLDER))
    await prepareExportHtml()
    // The bake is not "complete" until every diagram's PNG is in the cache — that is the gate
    // the synchronous `copy` handler waits on. If this were fire-and-forget, the first copy
    // would race the rasterization and drop diagrams.
    expect(mermaidPngCache.get('h-eb')?.dataUrl).toBe('data:image/png;base64,MOCKPNG')
    expect(needsExportBake()).toBe(false)
  })

  it('is idempotent: a second call after completion is a cache read', async () => {
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml(PLACEHOLDER))
    await prepareExportHtml()
    renderMock.mockClear()
    const again = await prepareExportHtml()
    expect(renderMock).not.toHaveBeenCalled()
    expect(again).toContain('<svg')
  })

  it('shares one in-flight bake between concurrent callers', async () => {
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml(PLACEHOLDER))
    const [a, b] = await Promise.all([prepareExportHtml(), prepareExportHtml()])
    expect(a).toBe(b)
    expect(renderMock).toHaveBeenCalledTimes(1)
  })

  it('does not publish a stale bake when the document was re-parsed meanwhile', async () => {
    // The deferred is created up front so `release` exists synchronously (the render itself
    // only starts after the dynamic mermaid import resolves).
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    renderMock.mockImplementationOnce(async () => {
      await gate
      return { svg: '<svg id="stale"></svg>' }
    })
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml(PLACEHOLDER))

    const pending = prepareExportHtml()
    // A re-parse lands while the bake is in flight and resets the cache — to DIFFERENT
    // content, which is what makes the in-flight result stale.
    setExportHtml(sanitizeHtml('<div data-mermaid-slot="0"></div><p>re-parsed</p>'))
    release()

    const out = await pending
    expect(out).toContain('<svg')
    // The newer (un-baked) html must survive: publishing the stale result would export a
    // document that no longer matches what the user sees.
    expect(getExportHtml()).not.toContain('<svg')
    expect(getExportHtml()).toContain('data-mermaid-slot="0"')
  })

  it('re-sanitizes the baked result, so injected markup cannot ride along', async () => {
    renderMock.mockImplementationOnce(async () => ({
      svg: '<svg><script>alert(1)</script><rect onclick="evil()" /></svg>',
    }))
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml(PLACEHOLDER))

    await prepareExportHtml()
    expect(getExportHtml()).not.toContain('onclick')
    expect(getExportHtml()).not.toContain('<script')
  })

  it('scheduleExportBake defers the bake and coalesces repeat calls', async () => {
    vi.useFakeTimers()
    try {
      setExportMermaidSlots(slots)
      setExportHtml(sanitizeHtml(PLACEHOLDER))
      scheduleExportBake(300)
      scheduleExportBake(300) // must coalesce, not queue one bake per call
      // Not yet: the bake must not run inline with the parse that scheduled it.
      expect(getExportHtml()).not.toContain('<svg')
      await vi.advanceTimersByTimeAsync(300)
      expect(getExportHtml()).toContain('<svg')
      expect(renderMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resetExportBake cancels a scheduled bake', async () => {
    vi.useFakeTimers()
    try {
      setExportMermaidSlots(slots)
      setExportHtml(sanitizeHtml(PLACEHOLDER))
      scheduleExportBake(300)
      resetExportBake()
      await vi.advanceTimersByTimeAsync(300)
      expect(getExportHtml()).not.toContain('<svg')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resetExportBake forgets the completed marker', async () => {
    setExportMermaidSlots(slots)
    setExportHtml(sanitizeHtml(PLACEHOLDER))
    await prepareExportHtml()
    expect(needsExportBake()).toBe(false)
    resetExportBake()
    expect(needsExportBake()).toBe(true)
  })
})

describe('needsExportBake', () => {
  it('is false without html, without slots, and once complete', async () => {
    expect(needsExportBake()).toBe(false)
    setExportHtml(sanitizeHtml(PLACEHOLDER))
    expect(needsExportBake()).toBe(false) // no slots yet
    setExportMermaidSlots(slots)
    expect(needsExportBake()).toBe(true)
    await prepareExportHtml()
    expect(needsExportBake()).toBe(false)
  })
})
