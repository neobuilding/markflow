import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { ExportDialog } from './ExportDialog'
import { useUIStore } from '../../store/ui'
import type { Document } from '../../types'

import '../../i18n'

const doc: Document = {
  id: 'a',
  title: 'My Note',
  folderPath: '/docs',
  content: '# hi',
  filePath: '/docs/a.md',
  encoding: 'utf-8',

  encodingConfidence: 1,
  createdAt: 1,
  updatedAt: 1,
  wordCount: 1,
}

const exportDocument = vi.fn(async () => {})
const getExportHtml = vi.fn<() => string | null>(() => '<h1>hi</h1>')
// C20 ⑨: the preview renders the export's parts; the fake carries one recognisable marker per
// part so the test can tell "the export's own stylesheet" from "the app's styling".
const buildExportParts = vi.fn(async (opts: { theme: 'light' | 'dark' }) => ({
  theme: opts.theme,
  lang: 'en',
  body: '<h1>hi</h1>',
  css: '.markdown-body{color:#111111}',
  fontCss: '@font-face{font-family:Probe;src:url(data:font/woff;base64,AA)}',
  rootVars: '  --md-pre-bg: #edf2f9;',
  containerCss: 'padding:24px;',
  printCss: '@media print{.markdown-body hr{display:block}}',
}))

vi.mock('../../hooks/useDocuments', () => ({
  // Mirror the real hook: no active document means no data. This keeps the
  // "no document open" branch of the default-path effect reachable in tests.
  useDocument: (id: string | null) => ({ data: id ? doc : undefined }),
}))
vi.mock('../../lib/export', () => ({
  exportDocument: (...a: unknown[]) => (globalThis as any).__exportDocument(...a),
  resolveTheme: (choice: string, ui: string) => (choice === 'current' ? ui : choice),
  // C20 ⑨: the export preview renders the export's own parts in a shadow root.
  buildExportParts: (...a: unknown[]) => (globalThis as any).__buildExportParts(...a),
}))
vi.mock('../../lib/exportStore', () => ({
  getExportHtml: () => (globalThis as any).__getExportHtml(),
  setExportHtml: () => {},
  setExportContent: () => {},
  // ADR 0019: the export dialog bakes every diagram before writing, so it also reads the
  // stashed mermaid sources.
  getExportMermaidSlots: () => (globalThis as any).__getExportMermaidSlots?.() ?? [],
  setExportMermaidSlots: () => {},
}))

beforeEach(() => {
  ;(globalThis as any).__exportDocument = exportDocument
  ;(globalThis as any).__getExportHtml = getExportHtml
  ;(globalThis as any).__buildExportParts = buildExportParts
  useUIStore.getState().setExportOpen(false)
  useUIStore.getState().setActiveDocumentId('a')
  useUIStore.getState().setTheme('light')
  useUIStore.getState().setExporting(false)
  // C20 补 ⑦: the export cache's readiness is mirrored in the store; the "ready" case is the
  // default for the existing assertions (the not-ready path has its own test below).
  useUIStore.getState().setExportReady(true)
  ;(window as unknown as { api: unknown }).api = {
    dialog: { saveHtmlFile: vi.fn(async () => '/out.html') },
    documents: {
      stat: vi.fn(async () => ({ exists: false })),
      watch: vi.fn(async () => {}),
      unwatch: vi.fn(async () => {}),
    },
  }
  exportDocument.mockReset()
  getExportHtml.mockReturnValue('<h1>hi</h1>')
})

afterEach(() => cleanup())

describe('ExportDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ExportDialog />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the export controls when open', async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    expect(await screen.findByText('Export as HTML')).toBeInTheDocument()
    expect(screen.getByText('Theme')).toBeInTheDocument()
    expect(screen.getByText(/Inline images/i)).toBeInTheDocument()
  })

  it("renders the export preview in a shadow root with the export's styles (C20 ⑨)", async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    const host = await screen.findByTestId('export-preview-host')
    await waitFor(() => expect(host.shadowRoot?.querySelector('.markdown-body')).not.toBeNull())
    const root = host.shadowRoot!
    // The preview must show the export's styling, not the app's: the export's sheet is inlined
    // into the shadow root.
    expect(root.querySelector('style')?.textContent).toContain('.markdown-body{color:#111111}')
    // S1: a shadow root does not register fonts, so the @font-face rules must live in the HOST
    // document instead.
    expect(document.getElementById('markflow-export-preview-fonts')?.textContent).toContain(
      '@font-face',
    )
    // S2: `body` does not match inside a shadow root, so the container declarations are applied
    // to the preview container.
    expect(root.querySelector('.export-preview-container')).not.toBeNull()
  })

  it('the theme select comes from the shared Select primitive (one focus ring, 36px)', async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    const select = await screen.findByRole('combobox')
    expect(select.className).toContain('focus-ring')
    expect(select.className).toContain('h-9')
    // The hand-rolled 1px ring this used to carry.
    expect(select.className).not.toContain('focus:ring-1')
  })

  it('re-renders the preview when the theme choice changes (C20 ⑨)', async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    const host = await screen.findByTestId('export-preview-host')
    await waitFor(() => expect(host.shadowRoot?.querySelector('.markdown-body')).not.toBeNull())
    expect(host.shadowRoot!.querySelector('.markdown-body')!.getAttribute('data-theme')).toBe(
      'light',
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dark' } })
    await waitFor(() =>
      expect(host.shadowRoot!.querySelector('.markdown-body')!.getAttribute('data-theme')).toBe(
        'dark',
      ),
    )
  })

  it('runs the export when confirm is clicked', async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    // wait for the default target path to be populated by the open effect
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    const exportBtn = screen.getByRole('button', { name: 'Export' })
    fireEvent.click(exportBtn)
    await waitFor(() => expect(exportDocument).toHaveBeenCalled())
    expect(useUIStore.getState().exportOpen).toBe(false)
  })

  it('disables the export button while the document is still rendering (C20 补 ⑦ / E12)', async () => {
    // The export cache still holds the PREVIOUS document's HTML during a switch or a pending
    // parse, so the button must be disabled (and say so) instead of writing the wrong file.
    useUIStore.getState().setExportReady(false)
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    const exportBtn = screen.getByRole('button', { name: 'Preparing…' })
    expect(exportBtn).toBeDisabled()
    expect(exportDocument).not.toHaveBeenCalled()
  })

  it('enables the export button once the document has rendered', async () => {
    useUIStore.getState().setExportReady(true)
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('prompts for overwrite when the target already exists', async () => {
    ;(
      window as unknown as {
        api: {
          dialog: { saveHtmlFile: (path?: string) => Promise<string> }
          documents: {
            stat: () => Promise<{ exists: boolean }>
            watch: () => Promise<void>
            unwatch: () => Promise<void>
          }
        }
      }
    ).api = {
      dialog: { saveHtmlFile: vi.fn(async () => '/out.html') },
      documents: {
        stat: vi.fn(async () => ({ exists: true })),
        watch: vi.fn(async () => {}),
        unwatch: vi.fn(async () => {}),
      },
    }
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    const exportBtn = screen.getByRole('button', { name: 'Export' })
    fireEvent.click(exportBtn)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Overwrite' })).toBeInTheDocument(),
    )
    // choose overwrite
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))
    await waitFor(() =>
      expect(exportDocument).toHaveBeenCalledWith(expect.objectContaining({ overwrite: true })),
    )
  })

  it('switches the theme choice', async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dark' } })
    expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument()
  })

  it('toggles inline images', async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeChecked()
    fireEvent.click(checkbox)
    expect(checkbox).not.toBeChecked()
  })

  it('picks a path when none is selected, then exports', async () => {
    useUIStore.getState().setActiveDocumentId(null)
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    // Let the open effect settle first: with no active document it leaves
    // targetPath null, so the click below goes through the picker instead of
    // racing the deferred default-path assignment.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const exportBtn = screen.getByRole('button', { name: 'Export' })
    // First click only picks the path (handleConfirm returns early when targetPath is null);
    // the second click performs the actual export.
    fireEvent.click(exportBtn)
    await waitFor(() => expect(screen.getByDisplayValue('/out.html')).toBeInTheDocument())
    fireEvent.click(exportBtn)
    await waitFor(() => expect(exportDocument).toHaveBeenCalled())
  })

  it('shows an error when export fails', async () => {
    exportDocument.mockRejectedValueOnce(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument())
    errorSpy.mockRestore()
  })

  it('exports when stat read fails (treated as not exists)', async () => {
    ;(
      window as unknown as {
        api: {
          dialog: { saveHtmlFile: (path?: string) => Promise<string> }
          documents: {
            stat: () => Promise<{ exists: boolean }>
            watch: () => Promise<void>
            unwatch: () => Promise<void>
          }
        }
      }
    ).api = {
      dialog: { saveHtmlFile: vi.fn(async () => '/out.html') },
      documents: {
        stat: vi.fn(async () => {
          throw new Error('no')
        }),
        watch: vi.fn(async () => {}),
        unwatch: vi.fn(async () => {}),
      },
    }
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(exportDocument).toHaveBeenCalled())
  })

  it('builds a default path from the title when there is no file path', async () => {
    const original = doc.filePath
    doc.filePath = ''
    try {
      useUIStore.getState().setExportOpen(true)
      render(<ExportDialog />)
      // defaultHtmlPath falls back to `${title}.html` when docPath is empty.
      await waitFor(() => expect(screen.getByDisplayValue('My Note.html')).toBeInTheDocument())
    } finally {
      doc.filePath = original
    }
  })

  it('cancels the export from the main dialog', async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useUIStore.getState().exportOpen).toBe(false)
  })

  it('cancels the overwrite prompt without exporting', async () => {
    ;(
      window as unknown as {
        api: {
          dialog: { saveHtmlFile: (path?: string) => Promise<string> }
          documents: {
            stat: () => Promise<{ exists: boolean }>
            watch: () => Promise<void>
            unwatch: () => Promise<void>
          }
        }
      }
    ).api = {
      dialog: { saveHtmlFile: vi.fn(async () => '/out.html') },
      documents: {
        stat: vi.fn(async () => ({ exists: true })),
        watch: vi.fn(async () => {}),
        unwatch: vi.fn(async () => {}),
      },
    }
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Overwrite' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // Cancelling the overwrite prompt keeps the dialog open and does not export.
    expect(exportDocument).not.toHaveBeenCalled()
    expect(useUIStore.getState().exportOpen).toBe(true)
  })

  it('ignores an unwatch failure during export', async () => {
    ;(
      window as unknown as {
        api: {
          dialog: { saveHtmlFile: (path?: string) => Promise<string> }
          documents: {
            stat: () => Promise<{ exists: boolean }>
            watch: () => Promise<void>
            unwatch: () => Promise<void>
          }
        }
      }
    ).api = {
      dialog: { saveHtmlFile: vi.fn(async () => '/out.html') },
      documents: {
        stat: vi.fn(async () => ({ exists: false })),
        watch: vi.fn(async () => {}),
        unwatch: vi.fn(async () => {
          throw new Error('no')
        }),
      },
    }
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(exportDocument).toHaveBeenCalled())
  })

  it('falls back to "Untitled.html" when there is no file path and no title', async () => {
    const originalPath = doc.filePath
    const originalTitle = doc.title
    doc.filePath = ''
    doc.title = ''
    try {
      useUIStore.getState().setExportOpen(true)
      render(<ExportDialog />)
      // defaultHtmlPath('', '') → `${'' || 'Untitled'}.html` === 'Untitled.html'
      await waitFor(() => expect(screen.getByDisplayValue('Untitled.html')).toBeInTheDocument())
    } finally {
      doc.filePath = originalPath
      doc.title = originalTitle
    }
  })

  it('surfaces an error when picking the path fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(
      window as unknown as {
        api: {
          dialog: { saveHtmlFile: (path?: string) => Promise<string> }
          documents: {
            stat: () => Promise<{ exists: boolean }>
            watch: () => Promise<void>
            unwatch: () => Promise<void>
          }
        }
      }
    ).api = {
      dialog: {
        saveHtmlFile: vi.fn(async () => {
          throw new Error('picker cancelled')
        }),
      },
      documents: {
        stat: vi.fn(async () => ({ exists: false })),
        watch: vi.fn(async () => {}),
        unwatch: vi.fn(async () => {}),
      },
    }
    useUIStore.getState().setActiveDocumentId(null)
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    // activeDocumentId is null → useEffect sets targetPath to null.
    const exportBtn = screen.getByRole('button', { name: 'Export' })
    fireEvent.click(exportBtn)
    // handleConfirm with no targetPath picks a path; the picker throws and is swallowed.
    await waitFor(() => expect(exportDocument).not.toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it('seeds the picker from the document when choosing a path', async () => {
    const saveHtmlFile = vi.fn(async () => '/picked.html')
    const apiWindow = window as unknown as {
      api: { dialog: Record<string, unknown>; documents: Record<string, unknown> }
    }
    apiWindow.api.dialog.saveHtmlFile = saveHtmlFile
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    // The "Choose" button runs handlePickPath directly, seeding the dialog from the document.
    fireEvent.click(screen.getByRole('button', { name: /choose/i }))
    await waitFor(() => expect(saveHtmlFile).toHaveBeenCalledWith('/docs/a.html'))
    await waitFor(() => expect(screen.getByDisplayValue('/picked.html')).toBeInTheDocument())
  })

  it('keeps the path empty when the picker is cancelled', async () => {
    const saveHtmlFile = vi.fn(async () => null)
    const apiWindow = window as unknown as {
      api: { dialog: Record<string, unknown>; documents: Record<string, unknown> }
    }
    apiWindow.api.dialog.saveHtmlFile = saveHtmlFile
    useUIStore.getState().setActiveDocumentId(null)
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    // The picker returns nothing (user cancelled) → no path is set and nothing is written.
    await waitFor(() => expect(saveHtmlFile).toHaveBeenCalled())
    expect(exportDocument).not.toHaveBeenCalled()
  })

  it('shows the busy label while the export is in flight', async () => {
    const pending = new Promise<void>(() => {})
    exportDocument.mockReturnValue(pending as unknown as Promise<void>)
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    const exportBtn = screen.getByRole('button', { name: 'Export' })
    fireEvent.click(exportBtn)
    await waitFor(() => expect(screen.getByText('Exporting…')).toBeInTheDocument())
  })

  it('copies the full target path via the right-click menu', async () => {
    const writeText = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      ...(window as unknown as { api: { dialog: unknown; documents: unknown } }).api,
      clipboard: { writeText },
      dialog: { saveHtmlFile: vi.fn(async () => '/out.html') },
      documents: { stat: vi.fn(async () => ({ exists: false })), watch: vi.fn(), unwatch: vi.fn() },
    }
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    fireEvent.contextMenu(screen.getByDisplayValue('/docs/a.html'))
    fireEvent.click(await screen.findByTestId('exp-copy-full-path'))
    expect(writeText).toHaveBeenCalledWith('/docs/a.html')
  })

  it('copies an empty string when there is no target path', async () => {
    const writeText = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      clipboard: { writeText },
      dialog: { saveHtmlFile: vi.fn(async () => '/out.html') },
      documents: { stat: vi.fn(async () => ({ exists: false })), watch: vi.fn(), unwatch: vi.fn() },
    }
    useUIStore.getState().setActiveDocumentId(null)
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const input = screen.getByPlaceholderText('Not selected')
    fireEvent.contextMenu(input)
    fireEvent.click(await screen.findByTestId('exp-copy-full-path'))
    expect(writeText).toHaveBeenCalledWith('')
  })
})
