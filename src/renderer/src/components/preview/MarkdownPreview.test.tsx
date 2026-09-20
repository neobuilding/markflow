import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MarkdownPreview } from './MarkdownPreview'
import { useUIStore } from '../../store/ui'
import { setExportHtml } from '../../lib/exportStore'
import { sanitizeHtml } from '../../lib/sanitize'
import type { RenderResult } from '../../lib/markdownPipeline'

import '../../i18n'
import { getExportHtml } from '../../lib/exportStore'

const parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
  html: '<p>hello preview</p>',
  mermaid: [],
}))

vi.mock('../../lib/parseClient', () => ({
  parseMarkdown: (...a: unknown[]) => (globalThis as any).__parseMarkdown(...a),
}))
vi.mock('../../lib/exportStore', () => {
  let html = ''
  // ADR 0019: the complete-bake path (export / print / copy) stores the mermaid SOURCES
  // next to the HTML, so this mock has to expose them too.
  let slots: unknown[] = []
  return {
    setExportHtml: (h: string) => {
      html = h
    },
    getExportHtml: () => html,
    setExportContent: () => {},
    getExportContent: () => '',
    setExportMermaidSlots: (s: unknown[]) => {
      slots = s
    },
    getExportMermaidSlots: () => slots,
  }
})
vi.mock('../../lib/scrollSync', () => ({
  scrollSync: { register: () => {}, unregister: () => {} },
}))
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: vi.fn(async (_id: string, _code: string) => ({ svg: '<svg>mermaid</svg>' })),
  },
}))

// jsdom has no IntersectionObserver, so a global mock (firing immediately) is injected in
// test-setup.ts. That covers this suite too: every mermaid placeholder is treated as visible
// and renders synchronously, which is what the D-E① lazy renderer asserts on.

beforeEach(() => {
  ;(globalThis as any).__parseMarkdown = parseMarkdown
  useUIStore.getState().setActiveDocumentId('d1')
  parseMarkdown.mockClear()
})

afterEach(() => cleanup())

describe('MarkdownPreview', () => {
  it('renders the parsed HTML after parsing', async () => {
    render(<MarkdownPreview content="# title" />)
    await waitFor(() => expect(screen.getByText('hello preview')).toBeInTheDocument())
  })

  it('injects parsed content directly into the <article> — no wrapper div (P8)', async () => {
    const { container } = render(<MarkdownPreview content="# title" />)
    await waitFor(() => expect(screen.getByText('hello preview')).toBeInTheDocument())
    const article = container.querySelector('article.markdown-preview') as HTMLElement
    // P8: the parsed <p> is the article's OWN child — the old SafeHtml wrapper <div> is gone,
    // so rich-text copy reads the content root directly (Plan 01 §5.5 contract #1).
    expect(article.firstElementChild?.tagName).toBe('P')
  })

  // R12① (plan-03 §4.2): the preview <article> is the document semantics root. role="document"
  // is always set; lang reflects a leading frontmatter `lang:` field (extracted by
  // extractFrontmatterLang) so assistive tech gets the right language. No frontmatter → no lang.
  it('exposes role="document" and omits lang without frontmatter (R12①)', async () => {
    const { container } = render(<MarkdownPreview content="# title" />)
    await waitFor(() =>
      expect(container.querySelector('article.markdown-preview')?.textContent).toContain(
        'hello preview',
      ),
    )
    const article = container.querySelector('article.markdown-preview') as HTMLElement
    expect(article).toBeTruthy()
    expect(article.getAttribute('role')).toBe('document')
    expect(article.hasAttribute('lang')).toBe(false)
  })

  it('mirrors a frontmatter lang onto the preview article (R12①)', async () => {
    const { container } = render(<MarkdownPreview content={'---\nlang: zh-CN\n---\n\n# title'} />)
    await waitFor(() =>
      expect(container.querySelector('article.markdown-preview')?.textContent).toContain(
        'hello preview',
      ),
    )
    const article = container.querySelector('article.markdown-preview') as HTMLElement
    expect(article.getAttribute('lang')).toBe('zh-CN')
  })

  it('shows the loading hint while nothing has been parsed', async () => {
    // delay the parse so the loading branch is observable
    ;(globalThis as any).__parseMarkdown = vi.fn(() => new Promise<RenderResult>(() => {}))
    render(<MarkdownPreview content="x" />)
    expect(await screen.findByText(/loading/i)).toBeInTheDocument()
  })

  it('re-parses when the document id changes', async () => {
    const { rerender } = render(<MarkdownPreview content="a" />)
    await waitFor(() => expect(screen.getByText('hello preview')).toBeInTheDocument())
    useUIStore.getState().setActiveDocumentId('d2')
    rerender(<MarkdownPreview content="b" />)
    await waitFor(() => expect(parseMarkdown).toHaveBeenCalledTimes(2))
  })

  it('bakes mermaid diagrams into the rendered HTML', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      // Real pipeline output for a top-level mermaid fence carries data-line (R6) —
      // the lazy placeholder renderer must tolerate it (regression guard for the
      // placeholder regex / data-line passthrough).
      html: '<div data-mermaid-slot="0" data-line="0"></div>',
      mermaid: [{ hash: 'h-bake', code: 'graph TD;A-->B', slot: 0 }],
    }))
    render(<MarkdownPreview content="```mermaid\ngraph TD;A-->B\n```" />)
    expect(await screen.findByText(/mermaid/)).toBeInTheDocument()
    expect(screen.queryByText('hello preview')).toBeNull()
  })

  // D-E① (plan-03 §4.3): mermaid renders lazily into the placeholder after the incremental
  // patch (IntersectionObserver mocked to fire immediately). The "Copy diagram source" menu was
  // removed in plan-02 D3, so the source is NOT written to the DOM as data-mermaid-source —
  // this guards the cleanup (plan-02 D9): no such attribute is emitted, and extra placeholder
  // attrs (data-line) still survive.
  it('renders mermaid lazily into the placeholder and emits no data-mermaid-source (D-E① / plan-02 D9)', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      // Includes the pipeline's R6 `data-line` (as a real top-level mermaid fence does) so
      // this also guards that the lazy renderer preserves extra placeholder attrs.
      html: '<div data-mermaid-slot="0" data-line="0"></div>',
      mermaid: [{ hash: 'h-lazy', code: 'graph TD;A-->B', slot: 0 }],
    }))
    const { container } = render(<MarkdownPreview content="```mermaid\ngraph TD;A-->B\n```" />)
    await waitFor(() => expect(container.querySelector('[data-mermaid-slot="0"] svg')).toBeTruthy())
    const wrapper = container.querySelector('[data-mermaid-slot="0"]')
    // No data-mermaid-source attribute is emitted (the "Copy diagram source" menu was removed).
    expect(wrapper?.hasAttribute('data-mermaid-source')).toBe(false)
    // The placeholder's data-line is preserved (source mapping survives).
    expect(wrapper?.getAttribute('data-line')).toBe('0')
  })

  // N4: mermaid bakes the id it is given into the SVG (root id, <style> selectors, node
  // ids, filter ids). A random id therefore makes the diagram markup differ on EVERY
  // re-parse, so morphdom can never take its "subtree unchanged -> skip" fast path and the
  // diagram is rebuilt while typing. We render with a random id (mermaid needs a
  // collision-free one) but normalise the baked markup to a deterministic id.
  it('bakes mermaid with a deterministic svg id, not the random render id (N4)', async () => {
    const renderIds: string[] = []
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<div data-mermaid-slot="0" data-line="0"></div>',
      mermaid: [{ hash: 'h-n4', code: 'graph TD;A-->B', slot: 0 }],
    }))
    const mermaidApi = (await import('mermaid')).default as unknown as {
      render: ReturnType<typeof vi.fn>
    }
    // Mimic real mermaid: the id passed to render() is echoed into the SVG markup.
    mermaidApi.render.mockImplementation(async (id: string) => {
      renderIds.push(id)
      return { svg: `<svg id="${id}"><use href="#${id}-flowchart-A-1"/></svg>` }
    })
    try {
      const { container } = render(<MarkdownPreview content="```mermaid\ngraph TD;A-->B\n```" />)
      await waitFor(() =>
        expect(container.querySelector('[data-mermaid-slot="0"] svg')).toBeTruthy(),
      )
      const svg = container.querySelector('[data-mermaid-slot="0"] svg') as SVGElement
      // mermaid still gets a random (collision-free) id…
      expect(renderIds[0]).toMatch(/^mermaid-h-n4-[a-z0-9]+$/)
      // …but what lands in the DOM is stable: hash + slot.
      expect(svg.id).toBe('mermaid-h-n4-0')
      expect(svg.querySelector('use')?.getAttribute('href')).toBe('#mermaid-h-n4-0-flowchart-A-1')
      // Nothing of the random token survives anywhere in the baked markup (it would also
      // appear in <style> selectors / filter ids in a real diagram).
      expect(svg.outerHTML).not.toContain(renderIds[0]!)
    } finally {
      mermaidApi.render.mockImplementation(async (_id: string, _code: string) => ({
        svg: '<svg>mermaid</svg>',
      }))
    }
  })

  it('falls back to a skeleton when mermaid rendering fails', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<div data-mermaid-slot="0" data-line="0"></div>',
      mermaid: [{ hash: 'h-fail', code: 'bad', slot: 0 }],
    }))
    const mermaid = (await import('mermaid')).default as unknown as {
      render: ReturnType<typeof vi.fn>
    }
    // ADR 0019: there are now TWO render paths for one diagram — the lazy preview and the
    // complete export bake — so a diagram that fails must fail on BOTH. `mockRejectedValue`
    // (persistent) is the honest mock for "this diagram cannot render"; `…Once` would let
    // the second path succeed and hide the failure.
    mermaid.render.mockRejectedValue(new Error('boom'))
    try {
      render(<MarkdownPreview content="mermaid" />)
      await waitFor(() => expect(screen.getByText(/Mermaid render failed/i)).toBeInTheDocument())
    } finally {
      mermaid.render.mockResolvedValue({ svg: '<svg>mermaid</svg>' })
    }
  })

  // ADR 0019: the preview keeps lazy placeholders, but the EXPORT CACHE must be a COMPLETE
  // render — export / print / copy read it, and they must not lose the diagrams that never
  // scrolled into view. (Under jsdom every placeholder "intersects" immediately, so this
  // asserts the cache is completed, not that it happened lazily.)
  it('completes the export cache with every diagram (ADR 0019)', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<div data-mermaid-slot="0"></div><div data-mermaid-slot="1"></div>',
      mermaid: [
        { hash: 'h-complete-0', code: 'graph TD;A-->B', slot: 0 },
        { hash: 'h-complete-1', code: 'graph TD;C-->D', slot: 1 },
      ],
    }))
    render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(getExportHtml()).toContain('<svg'))
    const doc = new DOMParser().parseFromString(`<body>${getExportHtml()}</body>`, 'text/html')
    expect(doc.querySelectorAll('[data-mermaid-slot] svg')).toHaveLength(2)
  })

  it('clears content and shows loading when switching documents', async () => {
    const { rerender } = render(<MarkdownPreview content="a" />)
    await waitFor(() => expect(screen.getByText('hello preview')).toBeInTheDocument())
    // Once parsing is pending on the new document, loading should show and the old HTML is cleared.
    ;(globalThis as any).__parseMarkdown = vi.fn(() => new Promise<RenderResult>(() => {}))
    useUIStore.getState().setActiveDocumentId('d2')
    rerender(<MarkdownPreview content="b" />)
    expect(await screen.findByText(/loading/i)).toBeInTheDocument()
    expect(screen.queryByText('hello preview')).toBeNull()
  })

  it('surfaces a parse error without crashing', async () => {
    const throwing = vi.fn(async (): Promise<RenderResult> => {
      throw new Error('parse boom')
    })
    ;(globalThis as any).__parseMarkdown = throwing
    render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(throwing).toHaveBeenCalled())
    // No exception escapes; the preview simply stops loading.
    expect(screen.queryByText('hello preview')).toBeNull()
  })

  // Ctrl+A inside the preview must be SCOPED to the article: the browser default selects
  // the whole document (both panes). The app-menu accelerator normally intercepts Ctrl+A
  // before the renderer sees it (menu:select-all → selectAllRouter), so this keydown is the
  // defence-in-depth path; both produce the same article-scoped selection.
  it('scopes Ctrl+A to the preview article instead of the whole document', async () => {
    const { container } = render(<MarkdownPreview content="# title" />)
    await waitFor(() => expect(screen.getByText('hello preview')).toBeInTheDocument())
    const article = container.querySelector('article.markdown-preview') as HTMLElement
    // cancelable:true is required — preventDefault() is a no-op on a non-cancelable event.
    const evt = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    fireEvent(article, evt)
    // preventDefault proves we took over: the browser's document-wide select-all is skipped.
    expect(evt.defaultPrevented).toBe(true)
  })

  it('takes over Ctrl+A for the meta (Cmd) modifier too', async () => {
    const { container } = render(<MarkdownPreview content="# title" />)
    await waitFor(() => expect(screen.getByText('hello preview')).toBeInTheDocument())
    const article = container.querySelector('article.markdown-preview') as HTMLElement
    const evt = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    fireEvent(article, evt)
    expect(evt.defaultPrevented).toBe(true)
  })

  it('leaves every other key combination to the browser', async () => {
    const { container } = render(<MarkdownPreview content="# title" />)
    await waitFor(() => expect(screen.getByText('hello preview')).toBeInTheDocument())
    const article = container.querySelector('article.markdown-preview') as HTMLElement
    // 'a' without a modifier, Ctrl+other key, and Ctrl+Shift+A / Ctrl+Alt+A all fall through.
    for (const init of [
      { key: 'a' },
      { key: 'b', ctrlKey: true },
      { key: 'a', ctrlKey: true, shiftKey: true },
      { key: 'a', ctrlKey: true, altKey: true },
    ]) {
      const evt = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      fireEvent(article, evt)
      expect(evt.defaultPrevented).toBe(false)
    }
  })

  it('replaces a broken image with a placeholder', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<img src="missing.png" alt="pic">',
      mermaid: [],
    }))
    const { container } = render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const img = container.querySelector('img') as HTMLImageElement
    fireEvent.error(img)
    expect(await screen.findByText(/Image failed to load: pic/i)).toBeInTheDocument()
  })

  it('falls back to the generic placeholder for a broken image without alt text', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<img src="missing.png">',
      mermaid: [],
    }))
    const { container } = render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const img = container.querySelector('img') as HTMLImageElement
    fireEvent.error(img)
    // No alt attribute: getAttribute('alt') returns null, so the `?? ''` fallback and the
    // generic (alt-less) message branch are both exercised the text must NOT carry the
    // ": <alt>" suffix used when alt text is present.
    const placeholder = await screen.findByText(/Image failed to load/)
    expect(placeholder.textContent).toBe('⚠ Image failed to load')
  })

  it('does not attach a scroll-compensation listener (no realign after image load)', async () => {
    // Plan 01 §5.4: the per-keystroke DOM rebuild (and the height jumps it caused) are gone,
    // so there is no `load`-time realign to exercise. Firing `load` on the rendered image must
    // be a harmless no-op that does not throw.
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<img src="ok.png">',
      mermaid: [],
    }))
    const { container } = render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const img = container.querySelector('img') as HTMLImageElement
    expect(() => fireEvent.load(img)).not.toThrow()
  })

  it('discards a stale parse result after a document switch', async () => {
    let resolveFirst: ((v: RenderResult) => void) | null = null
    // The first parse is held; a document switch re-renders with a new token before it resolves.
    ;(globalThis as any).__parseMarkdown = vi.fn((content: string): Promise<RenderResult> => {
      if (content === 'a') {
        return new Promise<RenderResult>((res) => {
          resolveFirst = res
        })
      }
      return Promise.resolve({ html: `<p>${content}</p>`, mermaid: [] })
    })
    const { rerender } = render(<MarkdownPreview content="a" />)
    // Let the first render's (immediate, 0ms) parse call register so we can resolve it later.
    await new Promise((r) => setTimeout(r, 1))
    // Switch the document before the first parse resolves → token advances.
    useUIStore.getState().setActiveDocumentId('d2')
    rerender(<MarkdownPreview content="b" />)
    // Resolve the stale first parse; it must be discarded (token mismatch guard), not rendered.
    resolveFirst!({ html: '<p>stale</p>', mermaid: [] })
    await waitFor(() => expect(screen.getByText('b')).toBeInTheDocument())
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('fills a previously empty pane without waiting the 150ms keystroke debounce', async () => {
    // PR fix: when the panes are emptied by a document switch and then filled
    // on the next commit (`docId` already changed on the prior commit so the
    // second render is NOT a doc-switch by the preview's own gate), the parse
    // must run `immediate`, not sit blank for 150ms.
    //
    // We mount on a fresh document with empty content (so prevContentRef stays
    // empty), then flip to non-empty content on the same doc. With the fix,
    // the second parse runs on the 0ms timer (`isRecovering` branch); without
    // it, the call would only land after the 150ms keystroke debounce.
    //
    // The component's mocked parseClient delegates to `globalThis.__parseMarkdown`,
    // so we observe via our own closure (the top-level `parseMarkdown` vi.fn
    // would only count calls routed through the default test mock).
    const calls: Array<{ content: string; docId: string | null }> = []
    ;(globalThis as any).__parseMarkdown = vi.fn(
      (content: string, docId: string | null): Promise<RenderResult> => {
        calls.push({ content, docId })
        return new Promise<RenderResult>(() => {})
      },
    )
    // Fresh doc so docId differs from any previous test's lastDocIdRef.
    useUIStore.getState().setActiveDocumentId('d-recover')
    const { rerender } = render(<MarkdownPreview content="" />)
    // Flip to non-empty content on the same doc `isRecovering` should fire
    rerender(<MarkdownPreview content="recovered" />)
    // Wait well under 150ms (the keystroke-debounce window). With `isRecovering`
    // the second parse lands on the 0ms timer; without it the call would only
    // land after 150ms.
    await waitFor(
      () => {
        expect(calls.some((c) => c.content === 'recovered')).toBe(true)
      },
      { timeout: 60 },
    )
    // Sanity: the parse ran with the expected docId (the active doc at the
    // time of the rerender) not some leftover value
    expect(calls.find((c) => c.content === 'recovered')?.docId).toBe('d-recover')
  })

  it('debounces consecutive keystrokes within the same document', async () => {
    // Complementary to the `isRecovering` case above: typing inside ONE document
    // is NOT a doc switch and NOT a recovery, so the parse must take the 150ms
    // keystroke-debounce path instead of firing immediately. This exercises the
    // third operand of `immediate` (`!hasContentRef.current`): after the first
    // parse has rendered, `hasContentRef.current` is true, so the operand
    // evaluates to false and the debounce applies.
    const calls: string[] = []
    ;(globalThis as any).__parseMarkdown = vi.fn(async (content: string) => {
      calls.push(content)
      return Promise.resolve({ html: `<p>${content}</p>`, mermaid: [] })
    })
    useUIStore.getState().setActiveDocumentId('d-keys')
    const { rerender } = render(<MarkdownPreview content="a" />)
    // First parse is immediate (mount counts as a doc switch); wait until it has
    // rendered so hasContentRef.current flips to true.
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument())
    expect(calls).toEqual(['a'])

    // Type in the same document: debounced, so nothing new within 50ms.
    rerender(<MarkdownPreview content="ab" />)
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual(['a'])

    // After the debounce window the keystroke parse lands.
    await waitFor(() => expect(calls).toEqual(['a', 'ab']), { timeout: 1000 })
  })

  it('ignores an error event that does not target an image', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<div>not an image</div>',
      mermaid: [],
    }))
    const { container } = render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(container.querySelector('div')).toBeTruthy())
    // Firing an error on a non-IMG element must not throw.
    fireEvent.error(container.querySelector('div') as HTMLElement)
    expect(container.querySelector('div')).toBeTruthy()
  })

  it('does not re-apply the image fallback on a second error', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<img src="missing.png" alt="pic">',
      mermaid: [],
    }))
    const { container } = render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const img = container.querySelector('img') as HTMLImageElement
    fireEvent.error(img)
    await waitFor(() => expect(screen.getByText(/Image failed to load: pic/i)).toBeInTheDocument())
    // A second error on the same (already-fallback-applied) image is a no-op.
    fireEvent.error(img)
    const placeholders = screen.queryAllByText(/Image failed to load: pic/i)
    expect(placeholders).toHaveLength(1)
  })

  it('attaches an onCopy writer that emits text/plain + text/html with internal attrs stripped (Plan 02 §4.3)', async () => {
    const { container } = render(<MarkdownPreview content={'hello preview'} />)
    const article = container.querySelector('article') as HTMLElement
    expect(article).toBeTruthy()
    // Wait for the async markdown parse + morphdom patch to populate the article.
    await waitFor(() => expect(article.innerHTML).toContain('hello preview'))
    // Drive the canonical export HTML (Phase 1 §5.5 contract #2) with the pipeline's internal
    // markers so we assert the copy payload strips them (R6) before writing. The whole-article
    // path reads this canonical HTML, not the live innerHTML.
    setExportHtml(
      sanitizeHtml(
        '<h1 tabindex="-1" data-line="0">Title</h1>' +
          '<pre data-lang="ts" data-baked="1"><code>body</code></pre>',
      ),
    )
    const setData = vi.fn()
    const evt = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(evt, 'clipboardData', { value: { setData } })
    article.dispatchEvent(evt)
    expect(setData).toHaveBeenCalledWith('text/plain', 'Titlebody')
    expect(setData).toHaveBeenCalledWith('text/html', '<h1>Title</h1><pre><code>body</code></pre>')
  })

  it('reserves space for local images by writing intrinsic dimensions before patch (R9)', async () => {
    ;(window as unknown as { api: unknown }).api = {
      documents: { imageSize: vi.fn(async () => ({ width: 10, height: 20 })) },
    }
    try {
      ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
        html: '<p><img src="appdoc://d1/img.png" alt="x"></p>',
        mermaid: [],
      }))
      const { container } = render(<MarkdownPreview content="![x](appdoc://d1/img.png)" />)
      await waitFor(() => {
        const img = container.querySelector('img')
        expect(img?.getAttribute('width')).toBe('10')
        expect(img?.getAttribute('height')).toBe('20')
      })
    } finally {
      ;(window as unknown as { api: unknown }).api = undefined
    }
  })

  it('does not crash when intrinsic dimension resolution fails (R9)', async () => {
    ;(window as unknown as { api: unknown }).api = {
      documents: { imageSize: vi.fn().mockRejectedValue(new Error('boom')) },
    }
    try {
      ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
        html: '<p><img src="appdoc://d1/img.png" alt="x"></p>',
        mermaid: [],
      }))
      const { container } = render(<MarkdownPreview content="![x](appdoc://d1/img.png)" />)
      await waitFor(() => {
        const img = container.querySelector('img')
        expect(img).toBeTruthy()
        expect(img?.hasAttribute('width')).toBe(false)
      })
    } finally {
      ;(window as unknown as { api: unknown }).api = undefined
    }
  })

  it('enables the github-markdown-css dark sheet when the UI theme is dark (D-B)', () => {
    useUIStore.getState().setTheme('dark')
    render(<MarkdownPreview content="# t" />)
    const light = document.getElementById('md-body-light') as HTMLStyleElement
    const dark = document.getElementById('md-body-dark') as HTMLStyleElement
    expect(light.disabled).toBe(true)
    expect(dark.disabled).toBe(false)
    useUIStore.getState().setTheme('light')
  })

  it('follows prefers-color-scheme when the UI theme is system (D-B)', () => {
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    useUIStore.getState().setTheme('system')
    render(<MarkdownPreview content="# t" />)
    const light = document.getElementById('md-body-light') as HTMLStyleElement
    const dark = document.getElementById('md-body-dark') as HTMLStyleElement
    expect(light.disabled).toBe(true) // OS dark → dark sheet active
    expect(dark.disabled).toBe(false)
    window.matchMedia = original
    useUIStore.getState().setTheme('light')
  })

  it('falls back to light when the UI theme is system but matchMedia is unavailable (D-B)', () => {
    const original = window.matchMedia
    // No matchMedia at all: the `typeof window !== 'undefined' && !!window.matchMedia` guard
    // must degrade to light rather than throwing.
    delete (window as unknown as { matchMedia?: unknown }).matchMedia
    try {
      useUIStore.getState().setTheme('system')
      render(<MarkdownPreview content="# t" />)
      const light = document.getElementById('md-body-light') as HTMLStyleElement
      const dark = document.getElementById('md-body-dark') as HTMLStyleElement
      expect(light.disabled).toBe(false)
      expect(dark.disabled).toBe(true)
    } finally {
      window.matchMedia = original
      useUIStore.getState().setTheme('light')
    }
  })

  it('still resolves the article theme when the stylesheets are missing (D-B)', () => {
    // The two sheets are injected once per module; removing them forces the
    // `if (light)` / `if (dark)` guards to take their null branch. The article's
    // data-theme must still be resolved — that is what the CSS variables hang off.
    document.getElementById('md-body-light')?.remove()
    document.getElementById('md-body-dark')?.remove()
    try {
      useUIStore.getState().setTheme('dark')
      const { container } = render(<MarkdownPreview content="# t" />)
      expect(container.querySelector('article')?.getAttribute('data-theme')).toBe('dark')
    } finally {
      useUIStore.getState().setTheme('light')
    }
  })

  it('leaves an image without a resolvable size untouched (R9)', async () => {
    ;(window as unknown as { api: unknown }).api = {
      documents: { imageSize: vi.fn(async () => null) },
    }
    try {
      ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
        html: '<p><img src="appdoc://d1/img.png" alt="x"></p>',
        mermaid: [],
      }))
      const { container } = render(<MarkdownPreview content="x" />)
      await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
      const img = container.querySelector('img') as HTMLImageElement
      // A null result must NOT be written as width="0" (that would collapse the box).
      expect(img.hasAttribute('width')).toBe(false)
      expect(img.hasAttribute('height')).toBe(false)
    } finally {
      ;(window as unknown as { api: unknown }).api = undefined
    }
  })

  it('never sends a non-appdoc image through the size IPC (R9)', async () => {
    const imageSize = vi.fn(async () => ({ width: 1, height: 1 }))
    ;(window as unknown as { api: unknown }).api = { documents: { imageSize } }
    try {
      ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
        html: '<p><img src="https://example.com/x.png" alt="x"></p>',
        mermaid: [],
      }))
      const { container } = render(<MarkdownPreview content="x" />)
      await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
      expect(imageSize).not.toHaveBeenCalled()
    } finally {
      ;(window as unknown as { api: unknown }).api = undefined
    }
  })

  it('fills an already-cached diagram immediately on re-parse instead of re-rendering it (D-E①)', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<div data-mermaid-slot="0"></div>',
      mermaid: [{ hash: 'h-cache-hit', code: 'graph TD;A-->B', slot: 0 }],
    }))
    const first = render(<MarkdownPreview content="a" />)
    await waitFor(() =>
      expect(first.container.querySelector('[data-mermaid-slot="0"] svg')).toBeTruthy(),
    )
    const mermaid = (await import('mermaid')).default as unknown as {
      render: ReturnType<typeof vi.fn>
    }
    mermaid.render.mockClear()
    cleanup()

    // Second mount == a re-parse of the same source: the hash cache must fill the slot with
    // the SAME svg, with no second mermaid render. This is the contract that keeps typing
    // (and the export bake) from re-rendering unchanged diagrams.
    const second = render(<MarkdownPreview content="a" />)
    await waitFor(() =>
      expect(second.container.querySelector('[data-mermaid-slot="0"] svg')).toBeTruthy(),
    )
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it('does NOT bake a placeholder that never intersects the viewport (D-E①)', async () => {
    // Replace the global (always-intersecting) jsdom mock with one that hands us the
    // callback, so we can drive the real decision with isIntersecting:false.
    let ioCallback!: (entries: unknown[]) => void
    const originalIO = (globalThis as unknown as { IntersectionObserver: unknown })
      .IntersectionObserver
    ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      constructor(cb: (entries: unknown[]) => void) {
        ioCallback = cb
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return []
      }
    }
    try {
      ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
        html: '<div data-mermaid-slot="0"></div>',
        mermaid: [{ hash: 'h-offscreen', code: 'graph TD;A-->B', slot: 0 }],
      }))
      const { container } = render(<MarkdownPreview content="x" />)
      await waitFor(() => expect(container.querySelector('[data-mermaid-slot="0"]')).toBeTruthy())
      const mermaid = (await import('mermaid')).default as unknown as {
        render: ReturnType<typeof vi.fn>
      }
      mermaid.render.mockClear()

      ioCallback([
        { isIntersecting: false, target: container.querySelector('[data-mermaid-slot="0"]') },
      ])
      await new Promise((r) => setTimeout(r, 10))

      // The heart of D-E①: an off-screen diagram costs nothing.
      expect(mermaid.render).not.toHaveBeenCalled()
      expect(container.querySelector('[data-mermaid-slot="0"] svg')).toBeNull()
    } finally {
      ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
        originalIO
    }
  })

  it('skips a mermaid placeholder whose slot is absent from the parsed slot list (D-E①)', async () => {
    // A placeholder in the DOM with no matching MermaidSlot (stale/stale-ish patch): the
    // loop must skip it rather than rendering an undefined slot.
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<div data-mermaid-slot="0"></div>',
      mermaid: [],
    }))
    const { container } = render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(container.querySelector('[data-mermaid-slot="0"]')).toBeTruthy())
    const mermaid = (await import('mermaid')).default as unknown as {
      render: ReturnType<typeof vi.fn>
    }
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it('discards a parse cancelled while the intrinsic-size lookup is still in flight', async () => {
    // Reaches the SECOND cancelled guard (the one after `await applyImageDimensions`): the
    // earlier guard already ran before unmount, so only a cancellation that happens during the
    // await can exercise it.
    setExportHtml(sanitizeHtml(''))
    let releaseSize!: () => void
    const sizeGate = new Promise<{ width: number; height: number }>((r) => {
      releaseSize = () => r({ width: 10, height: 20 })
    })
    ;(window as unknown as { api: unknown }).api = {
      documents: { imageSize: vi.fn(() => sizeGate) },
    }
    try {
      ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
        html: '<img src="appdoc://d1/img.png">',
        mermaid: [],
      }))
      const { unmount } = render(<MarkdownPreview content="x" />)
      // Let the parse start and reach the pending size lookup…
      await new Promise((r) => setTimeout(r, 1))
      unmount()
      releaseSize()
      await new Promise((r) => setTimeout(r, 10))
      // …then it must be dropped, not written into a tree that no longer exists.
      expect(getExportHtml()).not.toContain('<img')
    } finally {
      ;(window as unknown as { api: unknown }).api = undefined
    }
  })

  it('discards a parse that resolves after unmount instead of writing into a dead tree', async () => {
    let resolveLate!: (r: RenderResult) => void
    ;(globalThis as any).__parseMarkdown = vi.fn(
      () => new Promise<RenderResult>((res) => (resolveLate = res)),
    )
    const { unmount } = render(<MarkdownPreview content="a" />)
    await new Promise((r) => setTimeout(r, 1))
    unmount()
    resolveLate({ html: '<p>LATE</p>', mermaid: [] })
    await new Promise((r) => setTimeout(r, 10))
    expect(document.body.textContent ?? '').not.toContain('LATE')
  })

  it('does not report a parse failure that happens after unmount', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectLate!: (e: unknown) => void
    ;(globalThis as any).__parseMarkdown = vi.fn(
      () => new Promise<RenderResult>((_res, rej) => (rejectLate = rej)),
    )
    const { unmount } = render(<MarkdownPreview content="a" />)
    await new Promise((r) => setTimeout(r, 1))
    unmount()
    rejectLate(new Error('late boom'))
    await new Promise((r) => setTimeout(r, 10))
    // The cancelled guard must swallow it — an unmounted preview has no user to tell.
    expect(errSpy).not.toHaveBeenCalledWith('[MarkFlow] Parse failed:', expect.anything())
    errSpy.mockRestore()
  })
})
