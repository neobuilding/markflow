import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  bakeMermaidIntoHtml,
  bakeMermaidSlot,
  cacheMermaidPng,
  ensureMermaidPng,
  evictOldest,
  fillMermaidSlot,
  mermaidFailureMarkup,
  mermaidPngCache,
  mermaidSvgCache,
  readSvgHeight,
  renderMermaidSlot,
} from './mermaidBake'
import type { MermaidSlot } from './markdownPipeline'
import type { TranslationKey } from '../../../../shared/i18n/en'

// Mermaid is ~2.5MB and cannot run under jsdom, so it is mocked. The indirection through
// a global lets each test reconfigure the mock (render / reject) after module init.
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: (...a: unknown[]) =>
      (globalThis as unknown as { __mermaidRender: (...x: unknown[]) => unknown }).__mermaidRender(
        ...a,
      ),
  },
}))

const renderMock = vi.fn(async (id: string, _code: string) => ({
  svg: `<svg id="${id}"><use href="#${id}-flowchart-A-1"/></svg>`,
}))

// Canvas rasterization cannot run under jsdom (no Image.onload / 2d context / toDataURL), so the
// real `rasterizeSvg` is mocked. The mock returns a deterministic PNG entry; the real path is
// exercised end-to-end by the e2e suite in a real browser.
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

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string
const t = ((key: string) => `i18n:${key}`) as unknown as Translate

beforeEach(() => {
  ;(globalThis as unknown as { __mermaidRender: unknown }).__mermaidRender = renderMock
  renderMock.mockClear()
  mermaidSvgCache.clear()
  mermaidPngCache.clear()
})

describe('readSvgHeight', () => {
  it('reads the height attribute', () => {
    expect(readSvgHeight('<svg height="42"></svg>')).toBe(42)
  })

  it('falls back to the viewBox height', () => {
    expect(readSvgHeight('<svg viewBox="0 0 10 24"></svg>')).toBe(24)
  })

  it('returns undefined when neither is usable', () => {
    expect(readSvgHeight('<svg></svg>')).toBeUndefined()
    // A non-numeric height is not a usable reservation.
    expect(readSvgHeight('<svg height="100%"></svg>')).toBeUndefined()
  })

  it('returns undefined for a malformed viewBox', () => {
    // Not four numbers, and four numbers with a zero height — neither reserves anything.
    expect(readSvgHeight('<svg viewBox="0 0 10"></svg>')).toBeUndefined()
    expect(readSvgHeight('<svg viewBox="0 0 10 0"></svg>')).toBeUndefined()
  })
})

describe('fillMermaidSlot', () => {
  it('injects the svg and reserves the known height', () => {
    const el = document.createElement('div')
    fillMermaidSlot(el, { svg: '<svg></svg>', height: 120 })
    expect(el.querySelector('svg')).toBeTruthy()
    expect(el.style.minHeight).toBe('120px')
  })

  it('clears the reservation when no height is known', () => {
    const el = document.createElement('div')
    el.style.minHeight = '200px'
    fillMermaidSlot(el, { svg: '<svg></svg>' })
    expect(el.style.minHeight).toBe('')
  })
})

describe('mermaidFailureMarkup', () => {
  it('renders the skeleton with the localized message', () => {
    expect(mermaidFailureMarkup(t)).toContain('mermaid-skeleton')
    expect(mermaidFailureMarkup(t)).toContain('i18n:preview.mermaidFailed')
  })
})

describe('cacheMermaidPng (D14 PNG cache)', () => {
  it('keeps the existing PNG when the hash is already cached (early return)', () => {
    const entry = { dataUrl: 'data:image/png;base64,FIRST', width: 10, height: 20 }
    mermaidPngCache.set('h-png', entry)
    cacheMermaidPng('h-png', '<svg></svg>')
    expect(mermaidPngCache.get('h-png')).toBe(entry)
  })
})

describe('ensureMermaidPng (D14 awaitable + de-duped PNG cache)', () => {
  it('rasterizes and caches the PNG when missing', async () => {
    await ensureMermaidPng('h-new', '<svg></svg>')
    expect(mermaidPngCache.get('h-new')?.dataUrl).toBe('data:image/png;base64,MOCKPNG')
  })

  it('resolves immediately (no second rasterization) when already cached', async () => {
    mermaidPngCache.set('h-hit', { dataUrl: 'data:image/png;base64,HIT', width: 1, height: 1 })
    const { rasterizeSvg } = await import('./rasterize')
    const before = (rasterizeSvg as ReturnType<typeof vi.fn>).mock.calls.length
    await ensureMermaidPng('h-hit', '<svg></svg>')
    expect((rasterizeSvg as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
  })

  it('collapses concurrent calls for the same hash into one rasterization', async () => {
    const { rasterizeSvg } = await import('./rasterize')
    ;(rasterizeSvg as ReturnType<typeof vi.fn>).mockClear()
    const p1 = ensureMermaidPng('h-dup', '<svg></svg>')
    const p2 = ensureMermaidPng('h-dup', '<svg></svg>')
    await Promise.all([p1, p2])
    expect((rasterizeSvg as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(mermaidPngCache.get('h-dup')?.dataUrl).toBe('data:image/png;base64,MOCKPNG')
  })
})

describe('evictOldest (plan-04 §4.3 FIFO cache cap)', () => {
  it('drops the oldest entries until the map fits the cap', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
    evictOldest(map, 2)
    expect([...map.keys()]).toEqual(['b', 'c'])
  })

  it('leaves a map within the cap untouched', () => {
    const map = new Map([['a', 1]])
    evictOldest(map, 5)
    expect([...map.keys()]).toEqual(['a'])
  })
})

describe('bakeMermaidSlot (shared cache)', () => {
  const slot: MermaidSlot = { slot: 0, code: 'graph TD;A-->B', hash: 'h1' }

  it('renders, normalises the id and caches by hash', async () => {
    const entry = await bakeMermaidSlot(slot)
    // N4: the baked markup carries the DETERMINISTIC id, not the random render id.
    expect(entry.svg).toContain('mermaid-h1-0')
    expect(renderMock.mock.calls[0][0]).toMatch(/^mermaid-h1-[a-z0-9]+$/)
    expect(mermaidSvgCache.get('h1')?.svg).toBe(entry.svg)
  })

  it('serves a cache hit without rendering again', async () => {
    await bakeMermaidSlot(slot)
    renderMock.mockClear()
    const again = await bakeMermaidSlot(slot)
    expect(renderMock).not.toHaveBeenCalled()
    expect(again.svg).toContain('mermaid-h1-0')
  })

  it('reuses the module-level mermaid instance for a second diagram', async () => {
    await bakeMermaidSlot({ slot: 0, code: 'a', hash: 'ha' })
    await bakeMermaidSlot({ slot: 1, code: 'b', hash: 'hb' })
    expect(renderMock).toHaveBeenCalledTimes(2)
  })
})

describe('renderMermaidSlot (lazy DOM path)', () => {
  const slots: MermaidSlot[] = [{ slot: 0, code: 'graph TD;A-->B', hash: 'h-dom' }]

  function placeholder(attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('data-mermaid-slot', '0')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    return el
  }

  it('does nothing without a slot attribute', async () => {
    const el = document.createElement('div')
    await renderMermaidSlot(el, slots, t)
    expect(renderMock).not.toHaveBeenCalled()
  })

  it('does nothing when the slot is not in the parsed slot list', async () => {
    const el = placeholder()
    await renderMermaidSlot(el, [{ slot: 9, code: 'x', hash: 'h9' }], t)
    expect(el.innerHTML).toBe('')
  })

  it('renders into the placeholder and keeps sibling attributes', async () => {
    const el = placeholder({ 'data-line': '4' })
    await renderMermaidSlot(el, slots, t)
    expect(el.querySelector('svg')).toBeTruthy()
    expect(el.getAttribute('data-line')).toBe('4')
  })

  it('fills from the cache without rendering', async () => {
    const el = placeholder()
    mermaidSvgCache.set('h-dom', { svg: '<svg id="cached"></svg>' })
    await renderMermaidSlot(el, slots, t)
    expect(renderMock).not.toHaveBeenCalled()
    expect(el.querySelector('#cached')).toBeTruthy()
  })

  it('degrades to the skeleton when rendering fails', async () => {
    renderMock.mockRejectedValueOnce(new Error('boom'))
    const el = placeholder()
    await renderMermaidSlot(el, slots, t)
    expect(el.querySelector('.mermaid-skeleton')).toBeTruthy()
  })
})

describe('bakeMermaidIntoHtml (complete string path, ADR 0019)', () => {
  const slots: MermaidSlot[] = [
    { slot: 0, code: 'graph TD;A-->B', hash: 'h-s0' },
    { slot: 1, code: 'graph TD;C-->D', hash: 'h-s1' },
  ]
  const html =
    '<h1>Hi</h1><div data-mermaid-slot="0" data-line="2"></div>' +
    '<div data-mermaid-slot="1"></div>'

  it('returns the html untouched when there are no slots', async () => {
    await expect(bakeMermaidIntoHtml(html, [], t)).resolves.toBe(html)
  })

  it('returns the html untouched when it holds no placeholder', async () => {
    await expect(bakeMermaidIntoHtml('<p>no diagrams</p>', slots, t)).resolves.toBe(
      '<p>no diagrams</p>',
    )
  })

  it('bakes every placeholder and preserves their attributes', async () => {
    const out = await bakeMermaidIntoHtml(html, slots, t)
    const doc = new DOMParser().parseFromString(`<body>${out}</body>`, 'text/html')
    expect(doc.querySelectorAll('[data-mermaid-slot] svg')).toHaveLength(2)
    // R6 source mapping survives the complete bake.
    expect(doc.querySelector('[data-mermaid-slot="0"]')?.getAttribute('data-line')).toBe('2')
    expect(doc.querySelector('h1')?.textContent).toBe('Hi')
  })

  it('skips a placeholder whose slot is not in the parsed list', async () => {
    const out = await bakeMermaidIntoHtml('<div data-mermaid-slot="7"></div>', slots, t)
    expect(out).toBe('<div data-mermaid-slot="7"></div>')
    expect(renderMock).not.toHaveBeenCalled()
  })

  it('degrades a single failing diagram to the skeleton instead of dropping it', async () => {
    renderMock.mockRejectedValueOnce(new Error('boom'))
    const out = await bakeMermaidIntoHtml(html, slots, t)
    const doc = new DOMParser().parseFromString(`<body>${out}</body>`, 'text/html')
    expect(doc.querySelector('[data-mermaid-slot="0"] .mermaid-skeleton')).toBeTruthy()
    expect(doc.querySelector('[data-mermaid-slot="1"] svg')).toBeTruthy()
  })
})
