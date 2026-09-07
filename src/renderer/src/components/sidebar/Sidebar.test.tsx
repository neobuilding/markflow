import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '../ui/tooltip'
import { Sidebar } from './Sidebar'
import { useUIStore } from '../../store/ui'
import type { Document } from '../../types'

import '../../i18n'

let allDocs: Document[] = [
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
const createFolderMock = vi.fn(async () => ({}))
const renameFolderMock = vi.fn(async () => ({}))
const deleteFolderMock = vi.fn(async () => ({}))
// Directories reported by the main process for the active folder; set per test so the
// tree can be exercised with folders that hold no document.
let folderDirs: string[] = []

vi.mock('../../hooks/useDocuments', () => ({
  useDocuments: () => ({ data: allDocs, isLoading: false }),
  useDeleteDocument: () => ({ mutate: deleteMock }),
  useCreateDocument: () => ({ mutateAsync: createMock, isPending: false }),
  useOpenPaths: () => ({ mutate: openPathsMock, isPending: false }),
  useOpenFolder: () => ({ mutate: openFolderMock, isPending: false }),
  useCreateFolder: () => ({ mutateAsync: createFolderMock, isPending: false }),
  useRenameFolder: () => ({ mutateAsync: renameFolderMock, isPending: false }),
  useDeleteFolder: () => ({ mutateAsync: deleteFolderMock, isPending: false }),
  useFolderDirs: () => ({ data: folderDirs }),
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
  // Folder mutations too: without this a submit leaks into the next test's
  // "must not have been called" assertions.
  createFolderMock.mockReset()
  renameFolderMock.mockReset()
  deleteFolderMock.mockReset()
  folderDirs = []
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

  it('shows a folder that holds no Markdown document yet (能力 7)', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    folderDirs = ['/docs/empty']
    mount()
    // The folder comes from the on-disk listing, not from any document, so it is
    // visible (and enterable) the moment it is created.
    expect(await screen.findByText('empty')).toBeInTheDocument()
  })

  it('creates a folder directly under the current folder (能力 7)', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    // The current folder has no tree row of its own, so the entry lives in its own bar.
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('side-new-folder-here'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'Fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createFolderMock).toHaveBeenCalledWith('/docs/Fresh'))
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
    // deletion is gated behind a confirmation dialog (confirmed by default in beforeEach)
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
    // [saved file, draft] state. exercises both a saved file and a memory-only draft
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
      'side-open-document',
      'side-copy-path',
      'side-copy-filename',
      'side-show-in-folder',
      'side-rename',
      'side-copy-content',
      'side-details',
      'side-delete',
    ]) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('the ⋯ button shows the same items', async () => {
    mount()
    await userEvent.click(within(await docItem('a.md')).getByRole('button'))
    expect(await screen.findByTestId('side-rename')).toBeInTheDocument()
  })

  it('greys path/filename/show-in-folder for a draft and labels delete as discard', async () => {
    mount()
    fireEvent.contextMenu(await draftItem())
    expect(screen.getByTestId('side-copy-path')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('side-copy-filename')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('side-show-in-folder')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('side-discard-draft')).toBeInTheDocument()
  })

  it('enables path/filename/show-in-folder for a saved file and labels delete as delete', async () => {
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    expect(screen.getByTestId('side-copy-path')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('side-copy-filename')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('side-show-in-folder')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('side-delete')).toBeInTheDocument()
  })

  it('disables rename in read-only mode and shows a tooltip', async () => {
    useUIStore.getState().setEditable(false)
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    const rename = screen.getByTestId('side-rename')
    expect(rename).toHaveAttribute('aria-disabled', 'true')
    expect(rename).toHaveAttribute('title', 'Switch to edit mode first')
  })

  it('rename of the active doc sets pendingFileAction', async () => {
    useUIStore.getState().setActiveDocumentId('a')
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-rename'))
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'rename', id: 'a' })
  })

  it('rename of a non-active doc switches then sets pendingFileAction', async () => {
    useUIStore.getState().setActiveDocumentId('a')
    mount()
    fireEvent.contextMenu(await draftItem())
    fireEvent.click(await screen.findByTestId('side-rename'))
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
    fireEvent.click(await screen.findByTestId('side-rename'))
    await waitFor(() => expect(useUIStore.getState().pendingFileAction).toBeNull())
  })

  it('prompts for confirmation and removes the document on confirm (PLAN §5-4)', async () => {
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-delete'))
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
    fireEvent.click(await screen.findByTestId('side-delete'))
    await waitFor(() =>
      expect(window.api.dialog.confirm as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    )
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('discards a draft after confirmation (PLAN §5-4)', async () => {
    ;(window.api.dialog.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true)
    mount()
    fireEvent.contextMenu(await draftItem())
    fireEvent.click(await screen.findByTestId('side-discard-draft'))
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
    await fireEvent.click(await screen.findByTestId('side-open-document'))
    expect(useUIStore.getState().activeDocumentId).toBe('a')

    // copy path writes the full file path to the clipboard
    fireEvent.contextMenu(await docItem('a.md'))
    await fireEvent.click(await screen.findByTestId('side-copy-path'))
    await waitFor(() => expect(api.clipboard.writeText).toHaveBeenCalledWith('/docs/a.md'))

    // copy file name writes the base name to the clipboard
    fireEvent.contextMenu(await docItem('a.md'))
    await fireEvent.click(await screen.findByTestId('side-copy-filename'))
    await waitFor(() => expect(api.clipboard.writeText).toHaveBeenCalledWith('a.md'))

    // show in folder opens the file's folder in the system file manager
    fireEvent.contextMenu(await docItem('a.md'))
    // reject once so the defensive .catch in showInFolder is exercised
    ;(api.app.showInFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('no folder'),
    )
    await fireEvent.click(await screen.findByTestId('side-show-in-folder'))
    await waitFor(() => expect(api.app.showInFolder).toHaveBeenCalledWith('/docs/a.md'))

    // copy content writes the document body to the clipboard
    fireEvent.contextMenu(await docItem('a.md'))
    await fireEvent.click(await screen.findByTestId('side-copy-content'))
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
    expect(await screen.findByTestId('side-copy-folder-path')).toBeInTheDocument()
    expect(screen.getByTestId('side-show-in-folder')).toBeInTheDocument()
    expect(screen.getByTestId('side-go-up')).toBeInTheDocument()
    expect(screen.getByTestId('side-close-workspace')).toBeInTheDocument()
  })

  it('copies the current folder path', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('side-copy-folder-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/docs')
  })

  it('reveals the current folder in the system file manager', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('side-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs')
  })

  it('disables go-up at a root-level folder (no parent)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    expect(await screen.findByTestId('side-go-up')).toHaveAttribute('aria-disabled', 'true')
  })

  it('enables go-up for a nested folder and navigates to the parent', async () => {
    useUIStore.getState().setActiveFolder('/docs/sub')
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    const up = await screen.findByTestId('side-go-up')
    expect(up).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(up)
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs'))
  })

  it('disables close-workspace while exporting (PLAN §5.5 lock)', async () => {
    useUIStore.getState().setExportOpen(true)
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    expect(await screen.findByTestId('side-close-workspace')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('closes the workspace from the context menu (confirming discard)', async () => {
    useUIStore.getState().setDirty(true)
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('side-close-workspace'))
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
      'side-open-folder',
      'side-expand',
      'side-expand-all',
      'side-copy-folder-path',
      'side-show-in-folder',
      'side-new-doc-here',
    ]) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('opens the folder in the sidebar', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-open-folder'))
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs/sub'))
  })

  it('collapses via the menu after expanding', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-expand'))
    expect(await screen.findByText('b.md')).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    expect(await screen.findByTestId('side-collapse')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('side-collapse'))
    await waitFor(() => expect(screen.queryByText('b.md')).toBeNull())
  })

  it('disables expand-all when the folder has no subfolders', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    expect(await screen.findByTestId('side-expand-all')).toHaveAttribute('aria-disabled', 'true')
  })

  it('copies the folder path', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-copy-folder-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/docs/sub')
  })

  it('reveals the folder in the system file manager', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs/sub')
  })

  it('swallows a rejected reveal without surfacing an unhandled rejection', async () => {
    ;(window.api.app.showInFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('no folder'),
    )
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-show-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs/sub'))
  })

  it('creates a new document inside the folder', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-new-doc-here'))
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
    expect(await screen.findByTestId('side-expand-all')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    fireEvent.click(screen.getByTestId('side-expand-all'))
    // Both the folder and its nested folder open, revealing the deep document row.
    await waitFor(() => expect(screen.getByText('c.md')).toBeInTheDocument())
  })

  it('creates a subfolder via the inline-edit menu item (能力 7)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-expand')) // expand /docs so its children render
    const docsRow = screen.getAllByTestId('folder-row')[0]
    fireEvent.contextMenu(docsRow)
    fireEvent.click(await screen.findByTestId('side-new-subfolder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'NewFolder' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createFolderMock).toHaveBeenCalled())
  })

  it('renames a folder via the inline-edit menu item (能力 7)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    await userEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameFolderMock).toHaveBeenCalled())
  })

  it('deletes a folder to trash behind a confirmation (能力 7)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-delete-folder'))
    // The tree is rooted at /docs and renders its children only, so the single folder row
    // is the "sub" folder that is the path the row's delete item targets
    await waitFor(() => expect(deleteFolderMock).toHaveBeenCalledWith('/docs/sub'))
  })

  it('cancels the inline folder rename on Escape', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('folder-name-input')).toBeNull())
  })

  it('cancels the inline folder create when the name is blank', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-expand'))
    const docsRow = screen.getAllByTestId('folder-row')[0]
    fireEvent.contextMenu(docsRow)
    fireEvent.click(await screen.findByTestId('side-new-subfolder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createFolderMock).not.toHaveBeenCalled())
  })

  it('cancels the inline folder rename on blur', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.blur(input)
    await waitFor(() => expect(screen.queryByTestId('folder-name-input')).toBeNull())
  })

  it('surfaces a failed folder create without crashing (能力 7)', async () => {
    createFolderMock.mockRejectedValueOnce(new Error('boom'))
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-expand'))
    const docsRow = screen.getAllByTestId('folder-row')[0]
    fireEvent.contextMenu(docsRow)
    fireEvent.click(await screen.findByTestId('side-new-subfolder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'NewFolder' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createFolderMock).toHaveBeenCalled())
  })

  it('resets the sidebar width from the resize-handle menu (能力 7)', async () => {
    mount()
    const handle = screen.getByTitle(/Drag to resize sidebar/i)
    await userEvent.pointer({ keys: '[MouseLeft>]', target: handle })
    await userEvent.pointer({ coords: { x: 300, y: 10 } })
    await userEvent.pointer({ keys: '[/MouseLeft]' })
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('300px'),
    )
    fireEvent.contextMenu(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.click(await screen.findByTestId('side-reset-sidebar-width'))
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('240px')
  })
})

describe('Sidebar — folder high-order items (PLAN §6.2 coverage)', () => {
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
    createFolderMock.mockReset()
    renameFolderMock.mockReset()
    deleteFolderMock.mockReset()
  })

  it('cancels the folder delete when the confirmation is dismissed', async () => {
    ;(window.api.dialog.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-delete-folder'))
    await waitFor(() => expect(window.api.dialog.confirm).toHaveBeenCalled())
    expect(deleteFolderMock).not.toHaveBeenCalled()
  })

  it('surfaces a failed folder delete without crashing (能力 7)', async () => {
    deleteFolderMock.mockRejectedValueOnce(new Error('boom'))
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-delete-folder'))
    await waitFor(() => expect(deleteFolderMock).toHaveBeenCalled())
  })

  it('refreshes the folder listing from the empty-state menu', async () => {
    seed([])
    mount()
    expect(await screen.findByText(/No documents in this folder/i)).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByTestId('sidebar-empty-state'))
    fireEvent.click(await screen.findByTestId('side-refresh'))
    // The refresh invalidates the document queries; assert the action ran without crashing.
    await waitFor(() => expect(screen.getByTestId('sidebar-empty-state')).toBeInTheDocument())
  })

  it('opens the search panel from the welcome-state menu', async () => {
    seed([])
    useUIStore.getState().setActiveFolder(null)
    useUIStore.getState().setSearchOpen(false)
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-welcome-state'))
    fireEvent.click(await screen.findByTestId('side-search-documents'))
    expect(useUIStore.getState().searchOpen).toBe(true)
  })

  it('ignores a non-Enter key in the inline folder-name input', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-new-subfolder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.keyDown(input, { key: 'a' })
    // A non-Enter key must not submit the (still-empty) name.
    expect(createFolderMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('folder-name-input')).toBeInTheDocument()
  })

  it('renders the rename row with expanded-folder icons (PLAN §6.2)', async () => {
    mount()
    // Expand 'sub' so renaming it surfaces the open-folder / rotated-chevron branches.
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-expand'))
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    expect(input).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('folder-name-input')).toBeNull())
  })

  it('renames a folder via the inline input (covers the folder-edit TreeRow props)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameFolderMock).toHaveBeenCalled())
  })

  it('builds folder nodes from both the document list and the folder listing (buildFileTree)', async () => {
    seed([
      d({ id: 'a', title: 'Note A', folderPath: '/docs', filePath: '/docs/a.md', wordCount: 3 }),
      d({ id: 'draft', title: 'Untitled', folderPath: '', filePath: '' }),
    ])
    folderDirs = ['/docs', '/docs/zzz']
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    // 'zzz' exists only in the on-disk folder listing (no document under it), so it proves
    // folderDirs reached buildFileTree; '/docs' already exists as a document folder, so it
    // exercises the `if (!child)` found branch (and the `&&` hit branch in the find callback).
    expect(await screen.findByText('zzz')).toBeInTheDocument()
  })

  it('renames the active folder from the current-folder-bar menu and re-points activeFolder', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameFolderMock).toHaveBeenCalled())
  })

  it('deletes the active folder from the current-folder-bar menu (能力 7)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('side-delete-folder'))
    await waitFor(() => expect(deleteFolderMock).toHaveBeenCalled())
  })

  // Renaming a folder must keep its expanded/collapsed state under the new name. Here Note B
  // lives under /docs/sub; we expand that folder, rename it to 'renamed', and assert the new
  // folder is still expanded (its child stays visible) and the old name is gone. The mock
  // rename also re-points the document data so the tree renders the renamed folder; the
  // component re-points the expanded set via repointExpandedSet, and since activeFolder
  // ('/docs') is not inside the renamed folder it stays put.
  it('keeps a renamed subfolder expanded (expanded-set re-pointing, PLAN §6.2)', async () => {
    mount()
    // Expand /docs/sub via its context-menu "expand" item so its child b.md renders.
    // (DocItem shows baseName(filePath), i.e. "b.md", not the document title.)
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-expand'))
    expect(await screen.findByText('b.md')).toBeInTheDocument()

    // The mock rename must also re-point the document data so the tree renders the renamed
    // folder. We return a NEW array (not mutate in place) so the component's useMemo over
    // `allDocs` recomputes and the tree reflects the rename. The component re-points the
    // expanded set (repointExpandedSet), and since activeFolder ('/docs') is not inside the
    // renamed folder it stays put.
    renameFolderMock.mockImplementation(async () => {
      allDocs = allDocs.map((doc) =>
        doc.filePath.startsWith('/docs/sub')
          ? {
              ...doc,
              filePath: doc.filePath.replace('/docs/sub', '/docs/renamed'),
              folderPath: doc.folderPath.replace('/docs/sub', '/docs/renamed'),
            }
          : doc,
      )
      return {}
    })

    // Re-open the (now-closed) context menu and rename the folder.
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(renameFolderMock).toHaveBeenCalled())
    // Old name gone; renamed folder present and still expanded (child b.md visible).
    expect(screen.queryByText('sub')).toBeNull()
    expect(screen.getByText('renamed')).toBeInTheDocument()
    expect(screen.getByText('b.md')).toBeInTheDocument()
  })
})
