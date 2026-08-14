import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '../ui/tooltip'
import { Sidebar } from './Sidebar'
import { useUIStore } from '../../store/ui'
import type { Document } from '../../types'

import '../../i18n'

const allDocs: Document[] = [
  {
    id: 'a',
    title: 'Note A',
    folderPath: '/docs',
    content: '# A',
    filePath: '/docs/a.md',
    encoding: 'utf-8',
    isArchived: false,
    encodingConfidence: 1,
    createdAt: 1,
    updatedAt: 1,
    wordCount: 3,
  },
  {
    id: 'draft',
    title: 'Untitled',
    folderPath: '',
    content: '',
    filePath: '',
    encoding: 'utf-8',
    isArchived: false,
    encodingConfidence: 1,
    createdAt: 2,
    updatedAt: 2,
    wordCount: 0,
  },
]

const createMock = vi.fn(async () => ({ id: 'new', title: 'Untitled', filePath: '' }))
const deleteMock = vi.fn()
const openPathsMock = vi.fn()
const openFolderMock = vi.fn()

vi.mock('../../hooks/useDocuments', () => ({
  useDocuments: () => ({ data: allDocs, isLoading: false }),
  useDeleteDocument: () => ({ mutate: deleteMock }),
  useCreateDocument: () => ({ mutateAsync: createMock, isPending: false }),
  useOpenPaths: () => ({ mutate: openPathsMock, isPending: false }),
  useOpenFolder: () => ({ mutate: openFolderMock, isPending: false }),
}))

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useUIStore.getState().setSidebarOpen(true)
  useUIStore.getState().setActiveFolder(null)
  useUIStore.getState().setActiveDocumentId(null)
  useUIStore.getState().setDirty(false)
  ;(window as unknown as { api: unknown }).api = {
    dialog: {
      openFiles: vi.fn(async () => ['/x.md']),
      openFolderPath: vi.fn(async () => null),
      confirm: vi.fn(async () => true),
    },
  }
  createMock.mockReset()
  deleteMock.mockReset()
  openPathsMock.mockReset()
  openFolderMock.mockReset()
})

afterEach(() => cleanup())

describe('Sidebar', () => {
  it('renders nothing when the sidebar is closed', () => {
    useUIStore.getState().setSidebarOpen(false)
    const { container } = mount()
    expect(container.querySelector('aside')).toBeNull()
  })

  it('shows the welcome state when no folder and no drafts', () => {
    // Force an empty document list so the welcome guidance shows.
    allDocs.length = 0
    mount()
    expect(screen.getByText('No folder open')).toBeInTheDocument()
    allDocs.push(
      {
        id: 'a',
        title: 'Note A',
        folderPath: '/docs',
        content: '# A',
        filePath: '/docs/a.md',
        encoding: 'utf-8',
        isArchived: false,
        encodingConfidence: 1,
        createdAt: 1,
        updatedAt: 1,
        wordCount: 3,
      },
      {
        id: 'draft',
        title: 'Untitled',
        folderPath: '',
        content: '',
        filePath: '',
        encoding: 'utf-8',
        isArchived: false,
        encodingConfidence: 1,
        createdAt: 2,
        updatedAt: 2,
        wordCount: 0,
      },
    )
  })

  it('lists documents once a folder is active', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    // memory-only draft + folder doc both listed
    expect(await screen.findAllByTestId('doc-item')).toHaveLength(2)
  })

  it('creates a new document via the new button', async () => {
    mount()
    fireEvent.click(screen.getByTestId('new-document-btn'))
    await waitFor(() => expect(createMock).toHaveBeenCalled())
  })

  it('deletes a document via the context menu', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    const items = await screen.findAllByTestId('doc-item')
    // open the three-dot menu of the first item and choose delete
    const menuButton = within(items[0]).getByRole('button')
    await userEvent.click(menuButton)
    const deleteItem = await screen.findByText('Delete')
    fireEvent.click(deleteItem)
    expect(deleteMock).toHaveBeenCalled()
  })

  it('opens a file via the open-file button', async () => {
    mount()
    const openBtn = screen.getByRole('button', { name: 'Open File…' })
    fireEvent.click(openBtn)
    await waitFor(() => expect(openPathsMock).toHaveBeenCalled())
  })
})
