import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { ExportPreview } from './ExportPreview'
import { useUIStore } from '../../store/ui'
import type { ExportParts } from '../../lib/export'

import '../../i18n'

// C20 ⑨ — the export preview's own behaviour, tested at the component (not just through the
// dialog): readiness gating, the shadow-root skeleton, the "theme switch must not rebuild the
// body" rule, and the S1 font-sheet lifecycle.

const HOST_FONT_STYLE_ID = 'markflow-export-preview-fonts'

function makeParts(theme: 'light' | 'dark', body = '<h1>hi</h1>'): ExportParts {
  return {
    theme,
    lang: 'en',
    body,
    css: `.markdown-body{color:#111111} /* ${theme} */`,
    fontCss: '@font-face{font-family:Probe;src:url(data:font/woff;base64,AA)}',
    rootVars: '  --md-pre-bg: #edf2f9;',
    containerCss: 'padding:24px;',
    printCss: '@media print{}',
  }
}

const buildExportParts = vi.fn(async (opts: { theme: 'light' | 'dark'; body?: string }) =>
  makeParts(opts.theme, opts.body ?? '<h1>hi</h1>'),
)
const prepareExportHtml = vi.fn(async () => '<h1>hi</h1>')

vi.mock('../../lib/export', () => ({
  buildExportParts: (...a: unknown[]) => (globalThis as any).__buildExportParts(...a),
}))
vi.mock('../../lib/exportBake', () => ({
  prepareExportHtml: () => (globalThis as any).__prepareExportHtml(),
}))

function shadowOf(): ShadowRoot {
  const host = screen.getByTestId('export-preview')
  const root = host.shadowRoot
  if (!root) throw new Error('no shadow root')
  return root
}

beforeEach(() => {
  ;(globalThis as any).__buildExportParts = buildExportParts
  ;(globalThis as any).__prepareExportHtml = prepareExportHtml
  buildExportParts.mockClear()
  prepareExportHtml.mockClear()
  useUIStore.getState().setExportReady(true)
})

afterEach(() => {
  cleanup()
  document.getElementById(HOST_FONT_STYLE_ID)?.remove()
})

describe('ExportPreview (C20 ⑨)', () => {
  it('waits for the document instead of rendering the previous one', async () => {
    useUIStore.getState().setExportReady(false)
    render(<ExportPreview theme="light" />)
    // Preparing state is visible, and nothing is built from the stale cache.
    expect(await screen.findByText('Preparing…')).toBeInTheDocument()
    expect(buildExportParts).not.toHaveBeenCalled()
  })

  it('paints the export parts into a shadow root', async () => {
    render(<ExportPreview theme="light" />)
    await waitFor(() => expect(shadowOf().querySelector('.markdown-body')).not.toBeNull())
    const root = shadowOf()
    // The export's own sheet is inlined (not the app's).
    expect(root.querySelector('style[data-export-part="css"]')?.textContent).toContain(
      '.markdown-body{color:#111111}',
    )
    // S2: document-level custom properties go on :host; the container gets the body declarations.
    expect(root.querySelector('style[data-export-part="host-vars"]')?.textContent).toContain(
      ':host',
    )
    expect(root.querySelector('style[data-export-part="container"]')?.textContent).toContain(
      'padding:24px;',
    )
    // C20 ⑨: the host paints the EXPORTED page's own background (github-markdown-css
    // `--bgColor-default`), NOT the app chrome, so the page fills the preview edge-to-edge with no
    // grey `--color-bg` ring. The token is defined on `:host` and consumed by the host's own class.
    expect(root.querySelector('style[data-export-part="host-vars"]')?.textContent).toContain(
      '--bgColor-default: #ffffff;',
    )
    expect(screen.getByTestId('export-preview').className).toContain(
      'bg-[var(--bgColor-default,#ffffff)]',
    )
    expect(root.querySelector('.markdown-body')?.getAttribute('data-theme')).toBe('light')
    expect(root.querySelector('.export-preview-container')?.className).toBe(
      'export-preview-container',
    )
  })

  it('paints the exported dark page background so the preview has no app-coloured margin (C20 ⑨)', async () => {
    // The light case is covered by the "paints the export parts" test above; here we only need to
    // prove the page colour follows the theme the EXPORT will use (dark token #0d1117), not the app
    // chrome — which is what removes the grey ring around the page.
    render(<ExportPreview theme="dark" />)
    await waitFor(() =>
      expect(
        shadowOf().querySelector('style[data-export-part="host-vars"]')?.textContent,
      ).toContain('--bgColor-default: #0d1117;'),
    )
    expect(screen.getByTestId('export-preview').className).toContain(
      'bg-[var(--bgColor-default,#ffffff)]',
    )
  })

  it('publishes the KaTeX faces in the HOST document and removes them on unmount (S1)', async () => {
    const { unmount } = render(<ExportPreview theme="light" />)
    await waitFor(() =>
      expect(document.getElementById(HOST_FONT_STYLE_ID)?.textContent).toContain('@font-face'),
    )
    // A shadow root does not register fonts, so they must NOT be in the shadow tree.
    expect(shadowOf().querySelector('style[data-export-part="css"]')?.textContent).not.toContain(
      '@font-face',
    )
    unmount()
    // The removal is deferred one tick (StrictMode guard).
    await waitFor(() => expect(document.getElementById(HOST_FONT_STYLE_ID)).toBeNull())
  })

  it('re-paints styles on a theme switch without rebuilding the body or re-inlining images', async () => {
    const { rerender } = render(<ExportPreview theme="light" />)
    await waitFor(() => expect(shadowOf().querySelector('.markdown-body')).not.toBeNull())
    const nodeBefore = shadowOf().querySelector('.markdown-body')!.firstElementChild
    expect(buildExportParts).toHaveBeenCalledTimes(1)

    rerender(<ExportPreview theme="dark" />)
    await waitFor(() =>
      expect(shadowOf().querySelector('.markdown-body')?.getAttribute('data-theme')).toBe('dark'),
    )
    // Same DOM node ⇒ the body was not rebuilt (no image re-decode, no scroll reset).
    expect(shadowOf().querySelector('.markdown-body')!.firstElementChild).toBe(nodeBefore)
    // The second build reused the cached body, so the image IPC half was skipped.
    expect(buildExportParts).toHaveBeenCalledTimes(2)
    expect(buildExportParts.mock.calls[1][0]).toMatchObject({ theme: 'dark', body: '<h1>hi</h1>' })
    // Styles did refresh with the new theme.
    expect(shadowOf().querySelector('style[data-export-part="css"]')?.textContent).toContain('dark')
  })

  it('degrades to a message instead of crashing when the parts cannot be built', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    buildExportParts.mockRejectedValueOnce(new Error('boom'))
    render(<ExportPreview theme="light" />)
    expect(await screen.findByText('Preview unavailable.')).toBeInTheDocument()
    errorSpy.mockRestore()
  })

  // R4: the preview fills whatever space the dialog gives it; dragging/resizing now lives on the
  // dialog surface itself, so the preview carries no resize affordance of its own.
  it('fills its container and exposes no resize handle of its own', () => {
    render(<ExportPreview theme="light" />)
    const preview = screen.getByTestId('export-preview')
    expect(preview).toBeInTheDocument()
    expect(screen.queryByTestId('export-preview-resize-handle')).toBeNull()
    expect(preview.className).toContain('w-full')
    expect(preview.className).toContain('h-full')
  })

  // The dialog's caption above the pane is a plain <label>, which names nothing on its own: the
  // pane has to announce itself, or the export preview becomes an unlabelled region.
  it('announces itself as the labelled Preview group', () => {
    render(<ExportPreview theme="light" />)
    expect(screen.getByRole('group', { name: 'Preview' })).toBe(
      screen.getByTestId('export-preview'),
    )
  })
})
