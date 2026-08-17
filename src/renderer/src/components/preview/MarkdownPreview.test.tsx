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
})
