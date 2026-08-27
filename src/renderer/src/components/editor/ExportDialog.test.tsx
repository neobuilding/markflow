import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
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

vi.mock('../../hooks/useDocuments', () => ({
  useDocument: () => ({ data: doc }),
}))
vi.mock('../../lib/export', () => ({
  exportDocument: (...a: unknown[]) => (globalThis as any).__exportDocument(...a),
  resolveTheme: (choice: string, ui: string) => (choice === 'current' ? ui : choice),
}))
vi.mock('../../lib/exportStore', () => ({
  getExportHtml: () => (globalThis as any).__getExportHtml(),
  setExportHtml: () => {},
  setExportContent: () => {},
}))

beforeEach(() => {
  ;(globalThis as any).__exportDocument = exportDocument
  ;(globalThis as any).__getExportHtml = getExportHtml
  useUIStore.getState().setExportOpen(false)
  useUIStore.getState().setActiveDocumentId('a')
  useUIStore.getState().setTheme('light')
  useUIStore.getState().setExporting(false)
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

  it('shows an error when the preview is not ready', async () => {
    useUIStore.getState().setExportOpen(true)
    render(<ExportDialog />)
    await waitFor(() => expect(screen.getByDisplayValue('/docs/a.html')).toBeInTheDocument())
    getExportHtml.mockReturnValue(null)
    const exportBtn = screen.getByRole('button', { name: 'Export' })
    fireEvent.click(exportBtn)
    await waitFor(() => expect(screen.getByText(/preview/i)).toBeInTheDocument())
    expect(exportDocument).not.toHaveBeenCalled()
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
})
