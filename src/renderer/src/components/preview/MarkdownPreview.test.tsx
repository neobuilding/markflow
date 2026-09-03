import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MarkdownPreview } from './MarkdownPreview'
import { useUIStore } from '../../store/ui'
import type { RenderResult } from '../../lib/markdownPipeline'

import '../../i18n'

const parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
  html: '<p>hello preview</p>',
  mermaid: [],
}))

vi.mock('../../lib/parseClient', () => ({
  parseMarkdown: (...a: unknown[]) => (globalThis as any).__parseMarkdown(...a),
}))
vi.mock('../../lib/exportStore', () => ({
  setExportHtml: () => {},
  setExportContent: () => {},
}))
vi.mock('../../lib/scrollSync', () => ({
  scrollSync: { register: () => {}, unregister: () => {}, realign: () => {} },
}))
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: vi.fn(async (_id: string, _code: string) => ({ svg: '<svg>mermaid</svg>' })),
  },
}))

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
      html: '<div data-mermaid-slot="0"></div>',
      mermaid: [{ hash: 'h1', code: 'graph TD;A-->B', slot: 0 }],
    }))
    render(<MarkdownPreview content="```mermaid\ngraph TD;A-->B\n```" />)
    expect(await screen.findByText(/mermaid/)).toBeInTheDocument()
    expect(screen.queryByText('hello preview')).toBeNull()
  })

  it('falls back to a skeleton when mermaid rendering fails', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<div data-mermaid-slot="0"></div>',
      mermaid: [{ hash: 'h1', code: 'bad', slot: 0 }],
    }))
    const mermaid = (await import('mermaid')).default as unknown as {
      render: ReturnType<typeof vi.fn>
    }
    mermaid.render.mockRejectedValueOnce(new Error('boom'))
    render(<MarkdownPreview content="mermaid" />)
    await waitFor(() => expect(screen.getByText(/Mermaid render failed/i)).toBeInTheDocument())
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
    // generic (alt-less) message branch are both exercised — the text must NOT carry the
    // ": <alt>" suffix used when alt text is present.
    const placeholder = await screen.findByText(/Image failed to load/)
    expect(placeholder.textContent).toBe('⚠ Image failed to load')
  })

  it('realigns scroll on image load without throwing', async () => {
    ;(globalThis as any).__parseMarkdown = vi.fn(async (): Promise<RenderResult> => ({
      html: '<img src="ok.png">',
      mermaid: [],
    }))
    const { container } = render(<MarkdownPreview content="x" />)
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const img = container.querySelector('img') as HTMLImageElement
    fireEvent.load(img)
    // onLoad is debounced 150ms; just ensure the listener runs without throwing.
    await new Promise((r) => setTimeout(r, 200))
    expect(img).toBeTruthy()
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
    // Flip to non-empty content on the same doc — `isRecovering` should fire.
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
    // time of the rerender) — not some leftover value.
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
})
