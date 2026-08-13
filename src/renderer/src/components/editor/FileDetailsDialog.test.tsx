import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FileDetailsDialog } from './FileDetailsDialog'
import { useUIStore } from '../../store/ui'
import '../../i18n'

// Mock the document hooks used by the dialog.
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
        : undefined,
  }),
  useFileStat: () => ({
    data: { exists: true, size: 2048, createdAt: 500, updatedAt: 1000 },
  }),
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
})
