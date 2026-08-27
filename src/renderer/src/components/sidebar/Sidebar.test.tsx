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

describe('Sidebar — interactions', () => {
  function seedDocs(docs: Document[]) {
    allDocs.length = 0
    allDocs.push(...docs)
  }

  const doc = (over: Partial<Document>): Document => ({
    id: 'x',
    title: 'Untitled',
    folderPath: '',
    content: '',
    filePath: '',
    encoding: 'utf-8',
    encodingConfidence: 1,
    createdAt: 1,
    updatedAt: 1,
    wordCount: 0,
    ...over,
  })

  beforeEach(() => {
    seedDocs([
      doc({ id: 'a', title: 'Note A', folderPath: '/docs', filePath: '/docs/a.md', wordCount: 3 }),
      doc({
        id: 'b',
        title: 'Note B',
        folderPath: '/docs/sub',
        filePath: '/docs/sub/b.md',
        wordCount: 5,
      }),
      doc({ id: 'draft', title: 'Untitled', folderPath: '', filePath: '' }),
    ])
    useUIStore.getState().setActiveFolder('/docs')
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

  it('selects a document on click', async () => {
    mount()
    await userEvent.click(screen.getByText('a.md'))
    await waitFor(() => expect(useUIStore.getState().activeDocumentId).toBe('a'))
  })

  it('does not switch documents when unsaved changes are kept', async () => {
    useUIStore.getState().setActiveDocumentId('b')
    useUIStore.getState().setDirty(true)
    const api = {
      dialog: { openFiles: vi.fn(), openFolderPath: vi.fn(), confirm: vi.fn(async () => false) },
    }
    ;(window as unknown as { api: unknown }).api = api
    mount()
    await userEvent.click(screen.getByText('a.md'))
    await waitFor(() => expect(api.dialog.confirm).toHaveBeenCalled())
    expect(useUIStore.getState().activeDocumentId).toBe('b')
  })

  it('switches documents after confirming unsaved discard', async () => {
    useUIStore.getState().setActiveDocumentId('b')
    useUIStore.getState().setDirty(true)
    mount()
    await userEvent.click(screen.getByText('a.md'))
    await waitFor(() => expect(useUIStore.getState().activeDocumentId).toBe('a'))
  })

  it('deletes the active document and switches to the next', async () => {
    useUIStore.getState().setActiveDocumentId('a')
    mount()
    const items = await screen.findAllByTestId('doc-item')
    const aItem = items.find((li) => li.textContent?.includes('a.md'))
    expect(aItem).toBeTruthy()
    await userEvent.click(within(aItem as HTMLElement).getByRole('button'))
    const del = await screen.findByText('Delete')
    fireEvent.click(del)
    await waitFor(() => expect(useUIStore.getState().activeDocumentId).toBe('draft'))
  })

  it('expands and collapses a nested folder', async () => {
    mount()
    const folderBtn = screen.getByText('sub')
    await userEvent.click(folderBtn)
    expect(await screen.findByText('b.md')).toBeInTheDocument()
    await userEvent.click(folderBtn)
    await waitFor(() => expect(screen.queryByText('b.md')).toBeNull())
  })

  it('opens file details from the context menu', async () => {
    mount()
    const items = await screen.findAllByTestId('doc-item')
    const aItem = items.find((li) => li.textContent?.includes('a.md'))
    await userEvent.click(within(aItem as HTMLElement).getByRole('button'))
    const details = await screen.findByText('Details')
    fireEvent.click(details)
    expect(useUIStore.getState().fileDetailsId).toBe('a')
  })

  it('closes the workspace, keeping it when unsaved changes are kept', async () => {
    useUIStore.getState().setDirty(true)
    const api = {
      dialog: { openFiles: vi.fn(), openFolderPath: vi.fn(), confirm: vi.fn(async () => false) },
    }
    ;(window as unknown as { api: unknown }).api = api
    mount()
    await userEvent.click(screen.getByTestId('close-workspace-btn'))
    await waitFor(() => expect(api.dialog.confirm).toHaveBeenCalled())
    expect(useUIStore.getState().activeFolder).toBe('/docs')
  })

  it('closes the workspace after confirming unsaved discard', async () => {
    useUIStore.getState().setDirty(true)
    mount()
    await userEvent.click(screen.getByTestId('close-workspace-btn'))
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBeNull())
  })

  it('shows the empty state and creates the first document', async () => {
    seedDocs([])
    mount()
    expect(screen.getByText(/No documents in this folder/i)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('empty-create-btn'))
    await waitFor(() => expect(createMock).toHaveBeenCalled())
  })

  it('resizes the sidebar by dragging the handle', async () => {
    mount()
    const handle = screen.getByTitle(/Drag to resize sidebar/i)
    await userEvent.pointer({ keys: '[MouseLeft>]', target: handle })
    await userEvent.pointer({ coords: { x: 300, y: 10 } })
    await userEvent.pointer({ keys: '[/MouseLeft]' })
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('300px'),
    )
  })

  it('opens the search palette from the search button', async () => {
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(useUIStore.getState().searchOpen).toBe(true))
  })

  it('does nothing when the import-folder dialog returns no path', async () => {
    mount()
    await userEvent.click(screen.getByTestId('import-folder-btn'))
    // openFolderPath resolves to null in beforeEach → handleImportFolder returns early.
    await waitFor(() => expect(openFolderMock).not.toHaveBeenCalled())
  })

  it('cleans up the resize state on mouse-up after a drag', async () => {
    mount()
    const handle = screen.getByTitle(/Drag to resize sidebar/i)
    // Start a resize (registers the document mouseup listener), then release without moving.
    fireEvent.mouseDown(handle)
    expect(() => fireEvent.mouseUp(document)).not.toThrow()
    expect(() => fireEvent.mouseUp(document)).not.toThrow()
  })

  it('opens the context menu on right-click of a document row', async () => {
    mount()
    const items = await screen.findAllByTestId('doc-item')
    const aItem = items.find((li) => li.textContent?.includes('a.md'))
    expect(aItem).toBeTruthy()
    fireEvent.contextMenu(aItem as HTMLElement)
    expect(await screen.findByText('Delete')).toBeInTheDocument()
  })

  it('navigates to the parent folder via the up button', async () => {
    useUIStore.getState().setActiveFolder('/docs/sub')
    mount()
    // parentFolder('/docs/sub') = '/docs', so the button is enabled.
    const upBtn = screen.getByTestId('up-folder-btn') as HTMLButtonElement
    expect(upBtn.disabled).toBe(false)
    await userEvent.click(upBtn)
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs'))
  })

  it('disables the up button at a root-level folder (no parent)', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    // '/docs' has a single path segment, so there is no parent folder to go up to.
    const upBtn = screen.getByTestId('up-folder-btn') as HTMLButtonElement
    expect(upBtn.disabled).toBe(true)
    await userEvent.click(upBtn)
    // A disabled button is a no-op: the active folder stays put.
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs'))
  })

  it('renders the root folder name when the active folder ends with a separator', async () => {
    useUIStore.getState().setActiveFolder('/docs/')
    mount()
    // '/docs/'.split('/').filter(Boolean) = ['docs'], so pop() is 'docs' (no fallback).
    // Use a root-level path with a trailing separator to exercise the `?? activeFolder` fallback.
    useUIStore.getState().setActiveFolder('/')
    // The folder name falls back to the full path when the last segment is empty.
    await waitFor(() => expect(screen.getByText('/')).toBeInTheDocument())
  })

  it('enters a subfolder via the enter button in the tree', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    // Expand the nested 'sub' folder so its enter button is rendered.
    await userEvent.click(screen.getByText('sub'))
    expect(await screen.findByText('b.md')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('enter-folder-btn'))
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs/sub'))
  })

  it('enters a subfolder by double-clicking the folder row', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    fireEvent.doubleClick(screen.getByText('sub'))
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs/sub'))
  })
})
