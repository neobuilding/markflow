import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
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
})
