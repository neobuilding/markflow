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

  it('applies the platform-specific header padding (mac vs non-mac)', () => {
    // jsdom's default user agent is not a Mac, so the compact padding applies first.
    const { container, unmount } = mount()
    const header = container.querySelector('.titlebar-drag') as HTMLElement
    expect(header).toBeTruthy()
    expect(header.style.paddingLeft).toBe('0.75rem')
    unmount()

    // Re-render with a Mac user agent: the header reserves room for the traffic lights.
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    })
    try {
      const { container: macContainer } = mount()
      const macHeader = macContainer.querySelector('.titlebar-drag') as HTMLElement
      expect(macHeader.style.paddingLeft).toBe('5rem')
    } finally {
      // Drop the instance-level override so later tests see jsdom's default platform again.
      delete (navigator as unknown as { userAgent?: string }).userAgent
    }
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
    // open the three-dot menu of the saved file (a.md) and choose delete
    const savedItem = items.find((li) => li.textContent?.includes('a.md'))
    const menuButton = within(savedItem as HTMLElement).getByRole('button')
    await userEvent.click(menuButton)
    const deleteItem = await screen.findByText('Delete')
    fireEvent.click(deleteItem)
    // PLAN §5-4: deletion is gated behind a confirmation dialog (confirmed by default in beforeEach).
    await waitFor(() =>
      expect(window.api.dialog.confirm as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    )
    await waitFor(() => expect(deleteMock).toHaveBeenCalled())
  })

  it('opens a file via the open-file button', async () => {
    mount()
    const openBtn = screen.getByRole('button', { name: 'Open File…' })
    fireEvent.click(openBtn)
    await waitFor(() => expect(openPathsMock).toHaveBeenCalled())
  })

  it('does nothing when the open-file dialog returns no files', async () => {
    ;(
      window as unknown as {
        api: { dialog: { openFiles: unknown; openFolderPath: unknown; confirm: unknown } }
      }
    ).api = {
      dialog: {
        openFiles: vi.fn(async () => []),
        openFolderPath: vi.fn(async () => null),
        confirm: vi.fn(async () => true),
      },
    }
    mount()
    const openBtn = screen.getByRole('button', { name: 'Open File…' })
    fireEvent.click(openBtn)
    await waitFor(() => expect(openPathsMock).not.toHaveBeenCalled())
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

  it('closes the workspace directly with no unsaved changes (skips confirm)', async () => {
    useUIStore.getState().setDirty(false)
    const confirm = vi.fn(async () => true)
    ;(
      window as unknown as {
        api: { dialog: { openFiles: unknown; openFolderPath: unknown; confirm: unknown } }
      }
    ).api = {
      dialog: { openFiles: vi.fn(), openFolderPath: vi.fn(), confirm },
    }
    mount()
    await userEvent.click(screen.getByTestId('close-workspace-btn'))
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBeNull())
    expect(confirm).not.toHaveBeenCalled()
  })

  it('clears the active document when the last listed document is deleted', async () => {
    // Make 'a' the only listed document so deleting it leaves no `next`.
    const saved = allDocs.slice()
    allDocs.length = 0
    allDocs.push(saved[0])
    try {
      useUIStore.getState().setActiveDocumentId('a')
      mount()
      const items = await screen.findAllByTestId('doc-item')
      const aItem = items.find((li) => li.textContent?.includes('a.md'))
      await userEvent.click(within(aItem as HTMLElement).getByRole('button'))
      const del = await screen.findByText('Delete')
      fireEvent.click(del)
      await waitFor(() => expect(useUIStore.getState().activeDocumentId).toBeNull())
    } finally {
      allDocs.length = 0
      allDocs.push(...saved)
    }
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

  it('imports a chosen folder via openFolder', async () => {
    ;(window as unknown as { api: { dialog: { openFolderPath: unknown } } }).api = {
      dialog: { openFolderPath: vi.fn(async () => '/chosen/folder') },
    }
    mount()
    await userEvent.click(screen.getByTestId('import-folder-btn'))
    await waitFor(() => expect(openFolderMock).toHaveBeenCalledWith('/chosen/folder'))
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

describe('Sidebar — external deletion (VS Code-style missing document)', () => {
  it('strikes through a document whose file was deleted outside the app', () => {
    // The list only renders once a folder is active (otherwise the welcome state shows),
    // matching the existing "lists documents once a folder is active" test.
    useUIStore.getState().setActiveFolder('/docs')
    allDocs.push({
      id: 'gone',
      title: 'Gone',
      folderPath: '/docs',
      content: '# Gone',
      filePath: '/docs/gone.md',
      encoding: 'utf-8',
      encodingConfidence: 1,
      createdAt: 3,
      updatedAt: 3,
      wordCount: 1,
      missing: true,
    })
    try {
      mount()
      const nameSpan = screen.getByText('gone.md')
      expect(nameSpan.classList.contains('line-through')).toBe(true)
      // A still-present document keeps its normal styling.
      expect(screen.getByText('a.md').classList.contains('line-through')).toBe(false)
    } finally {
      allDocs.length = 2 // restore to the {a, draft} fixtures the other tests expect
    }
  })
})

describe('Sidebar document item context menu (PLAN §5)', () => {
  beforeEach(() => {
    // The shared `allDocs` fixture is mutated across describes (a subfolder describe adds
    // extra docs and an external-deletion test truncates it), so reset it here to a known
    // [saved file, draft] state. PLAN §5 exercises both a saved file and a memory-only draft.
    allDocs.length = 0
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
    useUIStore.getState().setActiveFolder('/docs')
    useUIStore.getState().setActiveDocumentId(null)
    useUIStore.getState().setDirty(false)
    useUIStore.getState().setEditable(true)
    useUIStore.getState().requestFileAction(null)
    ;(window as unknown as { api: unknown }).api = {
      dialog: {
        openFiles: vi.fn(async () => ['/x.md']),
        openFolderPath: vi.fn(async () => null),
        confirm: vi.fn(async () => true),
      },
      clipboard: { writeText: vi.fn(async () => {}) },
      app: { showInFolder: vi.fn(async () => {}) },
    }
  })

  function docItem(text: string) {
    return screen
      .findAllByTestId('doc-item')
      .then((all) => all.find((li) => li.textContent?.includes(text))) as Promise<HTMLElement>
  }

  // The draft has no on-disk path, so its list item shows the title (never a ".md" file name).
  function draftItem() {
    return screen
      .findAllByTestId('doc-item')
      .then((all) => all.find((li) => !li.textContent?.includes('.md'))) as Promise<HTMLElement>
  }

  it('shows the full 8-item menu on right-click of a saved file', async () => {
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    for (const id of [
      'ctx-open-document',
      'ctx-copy-path',
      'ctx-copy-filename',
      'ctx-show-in-folder',
      'ctx-rename',
      'ctx-copy-content',
      'ctx-details',
      'ctx-delete',
    ]) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('the ⋯ button shows the same items', async () => {
    mount()
    await userEvent.click(within(await docItem('a.md')).getByRole('button'))
    expect(await screen.findByTestId('ctx-rename')).toBeInTheDocument()
  })

  it('greys path/filename/show-in-folder for a draft and labels delete as discard', async () => {
    mount()
    fireEvent.contextMenu(await draftItem())
    expect(screen.getByTestId('ctx-copy-path')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-copy-filename')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-show-in-folder')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-discard-draft')).toBeInTheDocument()
  })

  it('enables path/filename/show-in-folder for a saved file and labels delete as delete', async () => {
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    expect(screen.getByTestId('ctx-copy-path')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-copy-filename')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-show-in-folder')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-delete')).toBeInTheDocument()
  })

  it('disables rename in read-only mode and shows a tooltip', async () => {
    useUIStore.getState().setEditable(false)
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    const rename = screen.getByTestId('ctx-rename')
    expect(rename).toHaveAttribute('aria-disabled', 'true')
    expect(rename).toHaveAttribute('title', 'Switch to edit mode first')
  })

  it('rename of the active doc sets pendingFileAction', async () => {
    useUIStore.getState().setActiveDocumentId('a')
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('ctx-rename'))
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'rename', id: 'a' })
  })

  it('rename of a non-active doc switches then sets pendingFileAction', async () => {
    useUIStore.getState().setActiveDocumentId('a')
    mount()
    fireEvent.contextMenu(await draftItem())
    fireEvent.click(await screen.findByTestId('ctx-rename'))
    await waitFor(() =>
      expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'rename', id: 'draft' }),
    )
  })

  it('rename aborts if switching is cancelled', async () => {
    useUIStore.getState().setActiveDocumentId('a')
    useUIStore.getState().setDirty(true)
    ;(window.api.dialog.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    mount()
    fireEvent.contextMenu(await draftItem())
    fireEvent.click(await screen.findByTestId('ctx-rename'))
    await waitFor(() => expect(useUIStore.getState().pendingFileAction).toBeNull())
  })

  it('prompts for confirmation and removes the document on confirm (PLAN §5-4)', async () => {
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('ctx-delete'))
    // The destructive action is gated behind the in-app confirm dialog before it runs.
    await waitFor(() =>
      expect(window.api.dialog.confirm as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    )
    await waitFor(() => expect(deleteMock).toHaveBeenCalled())
  })

  it('keeps the document when the delete confirmation is cancelled (PLAN §5-4)', async () => {
    ;(window.api.dialog.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('ctx-delete'))
    await waitFor(() =>
      expect(window.api.dialog.confirm as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    )
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('discards a draft after confirmation (PLAN §5-4)', async () => {
    ;(window.api.dialog.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true)
    mount()
    fireEvent.contextMenu(await draftItem())
    fireEvent.click(await screen.findByTestId('ctx-discard-draft'))
    await waitFor(() =>
      expect(window.api.dialog.confirm as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    )
    await waitFor(() => expect(deleteMock).toHaveBeenCalled())
  })

  it('context menu items invoke their file actions (PLAN §5)', async () => {
    mount()
    const api = window.api as unknown as {
      clipboard: { writeText: ReturnType<typeof vi.fn> }
      app: { showInFolder: ReturnType<typeof vi.fn> }
    }

    // open-document selects the document
    fireEvent.contextMenu(await docItem('a.md'))
    await fireEvent.click(await screen.findByTestId('ctx-open-document'))
    expect(useUIStore.getState().activeDocumentId).toBe('a')

    // copy path writes the full file path to the clipboard
    fireEvent.contextMenu(await docItem('a.md'))
    await fireEvent.click(await screen.findByTestId('ctx-copy-path'))
    await waitFor(() => expect(api.clipboard.writeText).toHaveBeenCalledWith('/docs/a.md'))

    // copy file name writes the base name to the clipboard
    fireEvent.contextMenu(await docItem('a.md'))
    await fireEvent.click(await screen.findByTestId('ctx-copy-filename'))
    await waitFor(() => expect(api.clipboard.writeText).toHaveBeenCalledWith('a.md'))

    // show in folder opens the file's folder in the system file manager
    fireEvent.contextMenu(await docItem('a.md'))
    // reject once so the defensive .catch in showInFolder is exercised (PLAN §5.3)
    ;(api.app.showInFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('no folder'),
    )
    await fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    await waitFor(() => expect(api.app.showInFolder).toHaveBeenCalledWith('/docs/a.md'))

    // copy content writes the document body to the clipboard
    fireEvent.contextMenu(await docItem('a.md'))
    await fireEvent.click(await screen.findByTestId('ctx-copy-content'))
    await waitFor(() => expect(api.clipboard.writeText).toHaveBeenCalledWith('# A'))
  })
})

describe('Sidebar — current folder bar context menu (PLAN §5.5)', () => {
  function seed(docs: Document[]) {
    allDocs.length = 0
    allDocs.push(...docs)
  }
  const d = (over: Partial<Document>): Document => ({
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
    seed([
      d({ id: 'a', title: 'Note A', folderPath: '/docs', filePath: '/docs/a.md', wordCount: 3 }),
    ])
    useUIStore.getState().setActiveFolder('/docs')
    useUIStore.getState().setActiveDocumentId(null)
    useUIStore.getState().setDirty(false)
    useUIStore.getState().setExportOpen(false)
    ;(window as unknown as { api: unknown }).api = {
      dialog: {
        openFiles: vi.fn(async () => ['/x.md']),
        openFolderPath: vi.fn(async () => null),
        confirm: vi.fn(async () => true),
      },
      clipboard: { writeText: vi.fn(async () => {}) },
      app: { showInFolder: vi.fn(async () => {}) },
    }
    createMock.mockReset()
    openFolderMock.mockReset()
  })

  it('shows copy path / reveal / go up / close workspace', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    expect(await screen.findByTestId('ctx-copy-folder-path')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-show-in-folder')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-go-up')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-close-workspace')).toBeInTheDocument()
  })

  it('copies the current folder path', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('ctx-copy-folder-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/docs')
  })

  it('reveals the current folder in the system file manager', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs')
  })

  it('disables go-up at a root-level folder (no parent)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    expect(await screen.findByTestId('ctx-go-up')).toHaveAttribute('aria-disabled', 'true')
  })

  it('enables go-up for a nested folder and navigates to the parent', async () => {
    useUIStore.getState().setActiveFolder('/docs/sub')
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    const up = await screen.findByTestId('ctx-go-up')
    expect(up).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(up)
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs'))
  })

  it('disables close-workspace while exporting (PLAN §5.5 lock)', async () => {
    useUIStore.getState().setExportOpen(true)
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    expect(await screen.findByTestId('ctx-close-workspace')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('closes the workspace from the context menu (confirming discard)', async () => {
    useUIStore.getState().setDirty(true)
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('ctx-close-workspace'))
    await waitFor(() => expect(window.api.dialog.confirm).toHaveBeenCalled())
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBeNull())
  })
})

describe('Sidebar — folder row context menu (PLAN §5.4)', () => {
  function seed(docs: Document[]) {
    allDocs.length = 0
    allDocs.push(...docs)
  }
  const d = (over: Partial<Document>): Document => ({
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
    seed([
      d({ id: 'a', title: 'Note A', folderPath: '/docs', filePath: '/docs/a.md', wordCount: 3 }),
      d({
        id: 'b',
        title: 'Note B',
        folderPath: '/docs/sub',
        filePath: '/docs/sub/b.md',
        wordCount: 5,
      }),
      d({ id: 'draft', title: 'Untitled', folderPath: '', filePath: '' }),
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
      clipboard: { writeText: vi.fn(async () => {}) },
      app: { showInFolder: vi.fn(async () => {}) },
    }
    createMock.mockReset()
    openFolderMock.mockReset()
  })

  it('shows the folder menu items', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    for (const id of [
      'ctx-open-folder',
      'ctx-expand',
      'ctx-expand-all',
      'ctx-copy-folder-path',
      'ctx-show-in-folder',
      'ctx-new-doc-here',
    ]) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('opens the folder in the sidebar', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('ctx-open-folder'))
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs/sub'))
  })

  it('collapses via the menu after expanding', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('ctx-expand'))
    expect(await screen.findByText('b.md')).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    expect(await screen.findByTestId('ctx-collapse')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ctx-collapse'))
    await waitFor(() => expect(screen.queryByText('b.md')).toBeNull())
  })

  it('disables expand-all when the folder has no subfolders', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    expect(await screen.findByTestId('ctx-expand-all')).toHaveAttribute('aria-disabled', 'true')
  })

  it('copies the folder path', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('ctx-copy-folder-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/docs/sub')
  })

  it('reveals the folder in the system file manager', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs/sub')
  })

  it('swallows a rejected reveal without surfacing an unhandled rejection', async () => {
    ;(window.api.app.showInFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('no folder'),
    )
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs/sub'))
  })

  it('creates a new document inside the folder', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('ctx-new-doc-here'))
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ folderPath: '/docs/sub', memoryOnly: false }),
      ),
    )
  })

  it('expand-all opens the whole subtree', async () => {
    // Give 'sub' a subfolder so expand-all is enabled.
    seed([
      d({ id: 'a', title: 'Note A', folderPath: '/docs', filePath: '/docs/a.md', wordCount: 3 }),
      d({
        id: 'b',
        title: 'Note B',
        folderPath: '/docs/sub',
        filePath: '/docs/sub/b.md',
        wordCount: 5,
      }),
      d({
        id: 'c',
        title: 'Note C',
        folderPath: '/docs/sub/deep',
        filePath: '/docs/sub/deep/c.md',
        wordCount: 1,
      }),
      d({ id: 'draft', title: 'Untitled', folderPath: '', filePath: '' }),
    ])
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    expect(await screen.findByTestId('ctx-expand-all')).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByTestId('ctx-expand-all'))
    // Both the folder and its nested folder open, revealing the deep document row.
    await waitFor(() => expect(screen.getByText('c.md')).toBeInTheDocument())
  })
})
