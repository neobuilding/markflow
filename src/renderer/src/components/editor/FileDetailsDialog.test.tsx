import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { FileDetailsDialog } from './FileDetailsDialog'
import { useUIStore } from '../../store/ui'
import '../../i18n'

// Mock the document hooks used by the dialog.
const fileStatData = { exists: true, size: 2048, createdAt: 500, updatedAt: 1000 }
vi.mock('../../hooks/useDocuments', () => ({
  useDocument: (id: string | null) => ({
    data:
      id === 'doc-1'
        ? {
            id: 'doc-1',
            title: 'Hello',
            filePath: '/tmp/hello.md',
            wordCount: 12,
            updatedAt: 1000,
          }
        : id === 'doc-draft'
          ? {
              id: 'doc-draft',
              title: 'Untitled',
              filePath: '',
              wordCount: 0,
              updatedAt: 2000,
            }
          : undefined,
  }),
  useFileStat: () => ({ data: fileStatData }),
  useCreateDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetEncoding: () => ({ mutateAsync: vi.fn() }),
  useDocuments: () => ({ data: [] }),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FileDetailsDialog', () => {
  beforeEach(() => {
    useUIStore.getState().setFileDetailsId(null)
  })

  it('renders nothing when no file is selected', () => {
    useUIStore.getState().setFileDetailsId(null)
    const { container } = render(<FileDetailsDialog />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows document details when opened', async () => {
    const showInFolder = vi.fn()
    ;(window as unknown as { api: { app: { showInFolder: typeof showInFolder } } }).api = {
      app: { showInFolder },
    }
    useUIStore.getState().setFileDetailsId('doc-1')
    render(<FileDetailsDialog />)
    expect(await screen.findByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('/tmp/hello.md')).toBeInTheDocument()
    expect(screen.getByText('2 KB')).toBeInTheDocument()
  })

  it('opens the containing folder via the API', async () => {
    const showInFolder = vi.fn()
    ;(window as unknown as { api: { app: { showInFolder: typeof showInFolder } } }).api = {
      app: { showInFolder },
    }
    useUIStore.getState().setFileDetailsId('doc-1')
    render(<FileDetailsDialog />)
    await screen.findByText('Hello')
    fireEvent.click(screen.getByRole('button', { name: /show in folder/i }))
    expect(showInFolder).toHaveBeenCalledWith('/tmp/hello.md')
  })

  it('closes on the close button', async () => {
    useUIStore.getState().setFileDetailsId('doc-1')
    render(<FileDetailsDialog />)
    await screen.findByText('Hello')
    fireEvent.click(screen.getByText('Close'))
    expect(useUIStore.getState().fileDetailsId).toBeNull()
  })

  it('closes via the dialog onOpenChange when dismissed', async () => {
    useUIStore.getState().setFileDetailsId('doc-1')
    render(<FileDetailsDialog />)
    await screen.findByText('Hello')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(useUIStore.getState().fileDetailsId).toBeNull())
  })

  it('copies the path to the clipboard and shows the copied state', async () => {
    const writeText = vi.fn(async () => {})
    // The dialog copies via the Electron preload bridge (window.api.clipboard),
    // not the browser's navigator.clipboard.
    ;(window as unknown as { api: { clipboard: { writeText: typeof writeText } } }).api = {
      clipboard: { writeText },
    }
    useUIStore.getState().setFileDetailsId('doc-1')
    render(<FileDetailsDialog />)
    await screen.findByText('Hello')
    fireEvent.click(screen.getByRole('button', { name: /copy path/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/tmp/hello.md'))
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })

  it('shows placeholders when the file stat is missing', async () => {
    fileStatData.exists = false
    useUIStore.getState().setFileDetailsId('doc-1')
    render(<FileDetailsDialog />)
    await screen.findByText('Hello')
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    // Modified falls back to the document's own updatedAt
    expect(screen.getByText(/1\/1\/1970|1970/)).toBeInTheDocument()
    fileStatData.exists = true
  })

  it('shows the unsaved note for a memory-only document', async () => {
    useUIStore.getState().setFileDetailsId('doc-draft')
    render(<FileDetailsDialog />)
    expect(await screen.findByText(/Unsaved/)).toBeInTheDocument()
  })

  it('resets the copied state after the timeout', async () => {
    const writeText = vi.fn(async () => {})
    ;(window as unknown as { api: { clipboard: { writeText: typeof writeText } } }).api = {
      clipboard: { writeText },
    }
    useUIStore.getState().setFileDetailsId('doc-1')
    render(<FileDetailsDialog />)
    await screen.findByText('Hello')
    fireEvent.click(screen.getByRole('button', { name: /copy path/i }))
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument())
    await new Promise((r) => setTimeout(r, 1600))
    expect(screen.queryByText('Copied')).toBeNull()
  })
})
