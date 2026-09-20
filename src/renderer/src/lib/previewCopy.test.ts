// ADR 0019 — the copy path must carry the diagrams too.
//
// The preview bakes mermaid lazily (D-E①), so the canonical export HTML it hands to copy
// starts out as EMPTY placeholders. `requestRichCopy` completes it first (async, menu path);
// the keyboard path cannot await and relies on the preview's background pass having already
// completed the same cache. Either way `buildPreviewCopyPayload` reads a complete string.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import '../i18n'
import { buildPreviewCopyPayload, stripInternalAttrs, requestRichCopy } from './previewCopy'
import { setExportHtml, setExportMermaidSlots, getExportHtml } from './exportStore'
import { prepareExportHtml, resetExportBake } from './exportBake'
import { sanitizeHtml } from './sanitize'
import { mermaidSvgCache } from './mermaidBake'

vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: async (id: string) => ({ svg: `<svg id="${id}"><rect/></svg>` }),
  },
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
    // Internal markers are still stripped from what the user pastes (R6).
    expect(html).not.toContain('data-mermaid-slot')
    expect(html).not.toContain('data-line')
    expect(text).not.toContain('stale dom')
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
})
