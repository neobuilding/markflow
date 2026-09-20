import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '../ui/tooltip'
import { Sidebar } from './Sidebar'
import { useUIStore } from '../../store/ui'
import type { Document } from '../../types'

import { t } from '../../i18n'

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
const renameFileMock = vi.fn(async () => ({}))
const deleteFolderMock = vi.fn(async () => ({}))
// Resolves to "nothing to undo" by default, so a stray Ctrl+Z in a test stays silent.
// `reason` is a general refusal code (the handler alerts on any value other than 'none'),
// so the type must stay open rather than narrowing to the literal 'none'.
const undoRenameMock = vi.fn(async (): Promise<{ ok: boolean; reason: string }> => ({
  ok: false,
  reason: 'none' as const,
}))
// Directories reported by the main process for the active folder; set per test so the
// tree can be exercised with folders that hold no document.
let folderDirs: string[] = []

// Platform seam: name comparison is case-insensitive off Linux (VS Code's rule), so the tests
// below pin the platform instead of inheriting whatever host happens to run them.
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
}
function restoreUserAgent() {
  delete (navigator as unknown as { userAgent?: string }).userAgent
}

vi.mock('../../hooks/useDocuments', () => ({
  useDocuments: () => ({ data: allDocs, isLoading: false }),
  useDeleteDocument: () => ({ mutate: deleteMock }),
  useCreateDocument: () => ({ mutateAsync: createMock, isPending: false }),
  useOpenPaths: () => ({ mutate: openPathsMock, isPending: false }),
  useOpenFolder: () => ({ mutate: openFolderMock, isPending: false }),
  useCreateFolder: () => ({ mutateAsync: createFolderMock, isPending: false }),
  useRenameFolder: () => ({ mutateAsync: renameFolderMock, isPending: false }),
  useRenameFile: () => ({ mutateAsync: renameFileMock, isPending: false }),
  useDeleteFolder: () => ({ mutateAsync: deleteFolderMock, isPending: false }),
  useUndoRename: () => ({ mutateAsync: undoRenameMock, isPending: false }),
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
  // "Show All Folders" and the just-created-folder pins are session state on the same
  // store, so they have to be cleared per test like the rest of the workspace.
  useUIStore.getState().setShowAllFolders(false)
  useUIStore.setState({ recentlyCreatedFolders: new Set<string>() })
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
  renameFileMock.mockReset()
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

  it('hides a folder that holds no Markdown document by default (能力 7)', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    folderDirs = ['/docs/empty']
    mount()
    // Default: the tree is derived from documents alone, so the empty folder present in
    // the on-disk listing never becomes a node.
    await waitFor(() => expect(screen.queryByTestId('folder-row')).toBeNull())
    expect(screen.queryByText('empty')).toBeNull()
  })

  it('shows every folder once "Show All Folders" is turned on (能力 7)', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    useUIStore.getState().setShowAllFolders(true)
    folderDirs = ['/docs/empty']
    mount()
    expect(await screen.findByText('empty')).toBeInTheDocument()
  })

  it('keeps a just-created folder visible even while it is still empty', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    // Created this session, so it is pinned: without the pin the filter would hide it
    // immediately and naming a folder would look like it did nothing.
    useUIStore.setState({ recentlyCreatedFolders: new Set(['/docs/empty']) })
    folderDirs = ['/docs/empty']
    mount()
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

  it('shows the name-clash note when the main process refuses a duplicate folder (EEXIST)', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    createFolderMock.mockRejectedValueOnce(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }))
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('side-new-folder-here'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'BrandNew' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const hint = await screen.findByTestId('file-name-hint')
    expect(hint.textContent).toBe(t('sidebar.nameExists', { name: 'BrandNew' }))
    // The row stays open: the refusal keeps the typed name instead of discarding it.
    expect(screen.queryByTestId('folder-name-input')).not.toBeNull()
  })

  it('shows a generic note when folder creation fails for a non-clash reason', async () => {
    useUIStore.getState().setActiveFolder('/docs')
    createFolderMock.mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    mount()
    fireEvent.contextMenu(screen.getByTestId('current-folder-bar'))
    fireEvent.click(await screen.findByTestId('side-new-folder-here'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'BrandNew' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const hint = await screen.findByTestId('file-name-hint')
    expect(hint.textContent).toBe(t('sidebar.createFailed', { name: 'BrandNew' }))
    expect(screen.queryByTestId('folder-name-input')).not.toBeNull()
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

  it('shows the empty state and opens the inline New File row', async () => {
    seedDocs([])
    mount()
    expect(screen.getByText(/No documents in this folder/i)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('empty-create-btn'))
    // The sidebar manages the current folder, so the empty-state CTA creates a real file
    // (not a memory-only draft): it opens the inline file-name input instead of calling create.
    await waitFor(() => expect(screen.getByTestId('file-create-row')).toBeInTheDocument())
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

  it('renames from read-only mode: the item stays enabled and enters inline rename (decoupled from edit mode)', async () => {
    // Files open read-only, so gating rename behind edit mode made the item permanently
    // grey. Renaming is a file operation (like delete), never gated; and it must NOT switch
    // edit mode on — it is a direct on-disk move, not a content edit.
    useUIStore.getState().setEditable(false)
    useUIStore.getState().setActiveDocumentId('a')
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    const rename = screen.getByTestId('side-rename')
    expect(rename).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(rename)
    // Clicking flips the row into an inline input prefilled with the current base name.
    const input = await screen.findByTestId('folder-name-input')
    expect(input).toHaveValue('a.md')
    // Edit mode was left untouched.
    expect(useUIStore.getState().editable).toBe(false)
  })

  it('starts an inline rename with F2 on the focused file row', async () => {
    mount()
    const item = await docItem('a.md')
    ;(item as HTMLElement).focus()
    fireEvent.keyDown(item as HTMLElement, { key: 'F2' })
    const input = await screen.findByTestId('folder-name-input')
    // Prefilled with the current base name, exactly like the context-menu rename.
    expect(input).toHaveValue('a.md')
  })

  it('ignores F2 when no row is focused (no data-kind ancestor)', () => {
    // Covers the `if (!row) return` branch of the F2 handler: the key landed on the sidebar root,
    // not on a document/folder row, so there is nothing to rename.
    mount()
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'F2' })
    expect(screen.queryByTestId('folder-name-input')).toBeNull()
  })

  it('ignores F2 on a row that has no on-disk path (a draft)', async () => {
    // Covers the `if (!path) return` branch: a memory-only draft row carries no data-path.
    mount()
    fireEvent.keyDown((await draftItem()) as HTMLElement, { key: 'F2' })
    expect(screen.queryByTestId('folder-name-input')).toBeNull()
  })

  it('ignores F2 on a stale file row whose document left the store', async () => {
    // Covers the `if (doc) startFileRename(doc)` false branch: the row is still a doc row, but the
    // store no longer holds a document with that path, so there is nothing to start renaming.
    mount()
    const row = (await docItem('a.md')) as HTMLElement
    row.dataset.path = '/gone.md'
    fireEvent.keyDown(row, { key: 'F2' })
    expect(screen.queryByTestId('folder-name-input')).toBeNull()
  })

  it('renders a memory-only row whose filePath is nullish (data-path falls back to empty)', async () => {
    // Covers the `doc.filePath ?? ''` RIGHT branch: a memory-only draft whose filePath is
    // nullish (never assigned a path) must still render, with data-path defaulting to ''.
    // activeFolder is null so the folder tree — which would call dirName on every doc and crash
    // on a nullish path — stays empty, and the doc falls into the "Unsaved drafts" group instead.
    useUIStore.getState().setActiveFolder(null)
    useUIStore.getState().setActiveDocumentId(null)
    const saved = [...allDocs]
    allDocs.length = 0
    allDocs.push({
      id: 'nopath',
      title: 'NoPath',
      folderPath: '',
      filePath: undefined as unknown as string,
      content: '# x',
      encoding: 'utf-8',
      encodingConfidence: 1,
      createdAt: 0,
      updatedAt: 0,
      wordCount: 1,
    })
    mount()
    const rows = await screen.findAllByTestId('doc-item')
    expect(rows.length).toBeGreaterThan(0)
    // The `?? ''` fallback: a nullish filePath yields an empty data-path rather than undefined.
    expect(rows[0].getAttribute('data-path')).toBe('')
    allDocs.length = 0
    allDocs.push(...saved)
  })

  it('renames any file, not just the open one, and moves it on disk immediately', async () => {
    // The active document is the draft; renaming the saved file a.md must not switch to it.
    useUIStore.getState().setActiveDocumentId('draft')
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-rename'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'renamed.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(renameFileMock).toHaveBeenCalledWith({
        oldPath: '/docs/a.md',
        newPath: '/docs/renamed.md',
      }),
    )
    // The rename never touched the open document or edit mode.
    expect(useUIStore.getState().activeDocumentId).toBe('draft')
    expect(useUIStore.getState().editable).toBe(false)
  })

  it('honours a typed Markdown extension instead of forcing .md', async () => {
    // The extension is shown in the input and is part of the name being edited, so typing a
    // different SUPPORTED one must rename a.md → a.markdown rather than forcing `.md` back on.
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-rename'))
    const input = await screen.findByTestId('folder-name-input')
    expect(input).toHaveValue('a.md')
    fireEvent.change(input, { target: { value: 'a.markdown' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(renameFileMock).toHaveBeenCalledWith({
        oldPath: '/docs/a.md',
        newPath: '/docs/a.markdown',
      }),
    )
  })

  it('refuses an extension the app cannot open and offers the .md spelling instead', async () => {
    // Renaming to a.txt would leave a file this app can never open again, so the commit is
    // refused: nothing is written and the row stays open showing the `.md` spelling.
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-rename'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'a.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(input).toHaveValue('a.md'))
    expect(renameFileMock).not.toHaveBeenCalled()
    // Still in edit state, so the user can accept the offered name or change it.
    expect(screen.getByTestId('folder-name-input')).toBeInTheDocument()
  })

  it('refuses a name with a path separator so a rename cannot escape the folder', async () => {
    // `sub/a.md` would move the file out of the folder (or fail on a missing directory), so it
    // is refused and the separator folded to `-` — the same folding create already applies.
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-rename'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'sub/a.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(input).toHaveValue('sub-a.md'))
    expect(renameFileMock).not.toHaveBeenCalled()
  })

  it('does not grow a second extension on a bare .md name', async () => {
    // A leading dot is not an extension elsewhere, but `.md` IS a supported one, so it must be
    // recognised as such instead of becoming `.md.md`.
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-rename'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: '.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(renameFileMock).toHaveBeenCalledWith({
        oldPath: '/docs/a.md',
        newPath: '/docs/.md',
      }),
    )
  })

  it('explains the refusal under the input and drops the note once the user types', async () => {
    // The rewrite alone would be a silent surprise, so the note names what was rejected — and
    // it must get out of the way the moment the user edits the name again.
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-rename'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'a.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const hint = await screen.findByTestId('file-name-hint')
    expect(hint.textContent).toContain('.txt')
    fireEvent.change(input, { target: { value: 'a.markdown' } })
    expect(screen.queryByTestId('file-name-hint')).toBeNull()
  })

  it('cancels the inline file rename on Escape', async () => {
    mount()
    fireEvent.contextMenu(await docItem('a.md'))
    fireEvent.click(await screen.findByTestId('side-rename'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('folder-name-input')).toBeNull())
    expect(renameFileMock).not.toHaveBeenCalled()
  })

  it('does not rename a memory-only draft (it has no path on disk yet)', async () => {
    mount()
    fireEvent.contextMenu(await draftItem())
    expect(screen.getByTestId('side-rename')).toHaveAttribute('aria-disabled', 'true')
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

  it('names a new file inside the folder inline instead of auto-naming it Untitled', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-new-doc-here'))
    // Same inline naming flow as the tree-area "New File": the row opens and the user types.
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'note.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
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

  it('orders the folder-row menu New Subfolder before New File (same section)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    const sub = await screen.findByTestId('side-new-subfolder')
    const file = await screen.findByTestId('side-new-doc-here')
    // New File Here must come AFTER New Subfolder, in the same section, matching the blank-area menu.
    expect(sub.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  it('names a folder in the folder-row font size', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    // A folder row prints its name at `text-base`; the input has to match it instead of
    // shrinking to the `text-xs` used for file names.
    expect(input.className).toContain('text-base')
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

  it('keeps the inline rename open when it loses focus', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.blur(input)
    // Only Enter commits and only Escape cancels: a stray click must never lose the typed name.
    expect(screen.getByTestId('folder-name-input')).toBeInTheDocument()
    expect(renameFolderMock).not.toHaveBeenCalled()
  })

  it('keeps a half-typed file name when the row loses focus', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    // The user is midway through the name — the extension has not been typed yet.
    fireEvent.change(input, { target: { value: 'notes' } })
    fireEvent.blur(input)
    // Nothing is created and nothing is discarded: the row is still there with the name in it.
    expect(screen.getByTestId('file-create-row')).toBeInTheDocument()
    expect(input).toHaveValue('notes')
    expect(createMock).not.toHaveBeenCalled()
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

  it('starts a folder rename with F2 on the focused folder row', async () => {
    mount()
    const row = screen.getByTestId('folder-row')
    row.focus()
    fireEvent.keyDown(row, { key: 'F2' })
    expect(await screen.findByTestId('folder-name-input')).toBeInTheDocument()
  })

  it('undoes the last rename on Ctrl+Z whenever focus is inside the sidebar', async () => {
    mount()
    // No row focused: unlike F2, the undo only needs the focus to be somewhere in the
    // sidebar (the handler is bound on the sidebar root, which is itself focusable).
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'z', ctrlKey: true })
    await waitFor(() => expect(undoRenameMock).toHaveBeenCalled())
  })

  it('alerts the user when an undo is blocked (target name taken again)', async () => {
    // A blocked undo (any reason other than "none") must surface to the user instead of
    // staying silent — this exercises the `window.alert` branch of the Ctrl+Z handler.
    undoRenameMock.mockImplementationOnce(async () => ({ ok: false, reason: 'occupied' as const }))
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    mount()
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'z', ctrlKey: true })
    await waitFor(() => expect(alert).toHaveBeenCalled())
    alert.mockRestore()
  })

  it('surfaces a failed folder delete to the user instead of swallowing it (能力 7)', async () => {
    deleteFolderMock.mockRejectedValueOnce(new Error('boom'))
    // The failure used to be console-only, leaving the folder in the tree with no explanation.
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-delete-folder'))
    await waitFor(() => expect(deleteFolderMock).toHaveBeenCalled())
    await waitFor(() => expect(alert).toHaveBeenCalled())
    alert.mockRestore()
  })

  it('toggles "Show All Folders" from the empty-state menu', async () => {
    seed([])
    mount()
    expect(await screen.findByText(/No documents in this folder/i)).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByTestId('sidebar-empty-state'))
    fireEvent.click(await screen.findByTestId('side-show-all-folders'))
    await waitFor(() => expect(useUIStore.getState().showAllFolders).toBe(true))
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
    // The folder listing only seeds the tree when the user asks for all folders.
    useUIStore.getState().setShowAllFolders(true)
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

// Where the temporary create row lands. The row is pinned into the SAME list as the real rows, at
// the folder/file seam, so these are the tests that would catch a regression back to "at the top
// of the sidebar".
describe('Sidebar — create row placement (folder / file boundary)', () => {
  const d = (over: Partial<Document>): Document => ({
    id: 'x',
    title: 'Untitled',
    folderPath: '',
    content: '',
    filePath: '',
    encoding: 'utf-8',
    encodingConfidence: 1,
    createdAt: 0,
    updatedAt: 0,
    wordCount: 0,
    ...over,
  })

  const seed = (docs: Document[]) => {
    allDocs.length = 0
    allDocs.push(...docs)
  }

  // Every row the tree area shows, in DOM order: a real row by its path, a temporary create row by
  // its testid (it has no path yet — and a memory-only draft has an empty one).
  const rowSequence = (): string[] =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="folder-row"], [data-testid="doc-item"], [data-testid="folder-create-row"], [data-testid="file-create-row"], [data-testid="sub-file-create-row"]',
      ),
    ).map((el) => el.getAttribute('data-path') || el.getAttribute('data-testid') || '')

  it('puts the root create row after the last subfolder and before the first file', async () => {
    seed([
      d({ id: 'a', folderPath: '/docs', filePath: '/docs/a.md' }),
      d({ id: 'z', folderPath: '/docs', filePath: '/docs/z.md' }),
      d({ id: 'sub', folderPath: '/docs/sub', filePath: '/docs/sub/x.md' }),
    ])
    folderDirs = ['/docs/sub']
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    expect(rowSequence()).toEqual(['/docs/sub', 'file-create-row', '/docs/a.md', '/docs/z.md'])
  })

  it('puts the root folder create row at the front, before the first folder', async () => {
    seed([
      d({ id: 'a', folderPath: '/docs', filePath: '/docs/a.md' }),
      d({ id: 'z', folderPath: '/docs', filePath: '/docs/z.md' }),
      d({ id: 'sub', folderPath: '/docs/sub', filePath: '/docs/sub/x.md' }),
    ])
    folderDirs = ['/docs/sub']
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-folder'))
    // A new folder leads the level (before '/docs/sub'), not after it (the old behaviour).
    expect(rowSequence()).toEqual(['folder-create-row', '/docs/sub', '/docs/a.md', '/docs/z.md'])
  })

  it('puts a nested folder create row at the front of that subfolder', async () => {
    seed([
      d({ id: 'a', folderPath: '/docs', filePath: '/docs/a.md' }),
      d({ id: 'one', folderPath: '/docs/sub', filePath: '/docs/sub/one.md' }),
      d({ id: 'two', folderPath: '/docs/sub/inner', filePath: '/docs/sub/inner/two.md' }),
    ])
    folderDirs = ['/docs/sub', '/docs/sub/inner']
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-new-subfolder'))
    // The new subfolder opens at the front of 'sub' (before 'sub/inner'), inside 'sub'.
    const seq = rowSequence()
    expect(seq.indexOf('folder-create-row')).toBeLessThan(seq.indexOf('/docs/sub/inner'))
  })

  it('puts it first when there is no subfolder, and keeps it below the unsaved drafts group', async () => {
    seed([
      d({ id: 'a', folderPath: '/docs', filePath: '/docs/a.md' }),
      d({ id: 'draft', title: 'Untitled', folderPath: '', filePath: '' }),
    ])
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    // The draft keeps its own group above the tree; with no folder in the way the new row leads it.
    expect(rowSequence()).toEqual(['doc-item', 'file-create-row', '/docs/a.md'])
  })

  it('still renders the row when the current folder is completely empty', async () => {
    seed([])
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    await userEvent.click(screen.getByTestId('empty-create-btn'))
    // Regression: the tree list used to be rendered only when it had rows of its own, which made
    // the row vanish inside an empty folder and the menu item look broken.
    expect(await screen.findByTestId('file-create-row')).toBeInTheDocument()
    expect(rowSequence()).toEqual(['file-create-row'])
  })

  it('puts a nested create row at the same seam inside that subfolder', async () => {
    seed([
      d({ id: 'a', folderPath: '/docs', filePath: '/docs/a.md' }),
      d({ id: 'one', folderPath: '/docs/sub', filePath: '/docs/sub/one.md' }),
      d({ id: 'two', folderPath: '/docs/sub/inner', filePath: '/docs/sub/inner/two.md' }),
    ])
    folderDirs = ['/docs/sub', '/docs/sub/inner']
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    // 'sub' holds a subfolder and a file, so the row has to land between them — and it opens
    // inside 'sub' without expanding it by hand.
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-new-doc-here'))
    expect(rowSequence()).toEqual([
      '/docs/sub',
      '/docs/sub/inner',
      'sub-file-create-row',
      '/docs/sub/one.md',
      '/docs/a.md',
    ])
  })

  it('keeps a folder row and a file row side by side when both are being created', async () => {
    seed([
      d({ id: 'a', folderPath: '/docs', filePath: '/docs/a.md' }),
      d({ id: 'sub', folderPath: '/docs/sub', filePath: '/docs/sub/x.md' }),
    ])
    folderDirs = ['/docs/sub']
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-folder'))
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    // The two are independent slots: the folder row leads the level, the file row keeps the seam
    // (after the last folder, before the first file), so both can be open at once.
    expect(rowSequence()).toEqual([
      'folder-create-row',
      '/docs/sub',
      'file-create-row',
      '/docs/a.md',
    ])
  })

  it('is the only child of a subfolder that holds nothing at all', async () => {
    seed([d({ id: 'a', folderPath: '/docs', filePath: '/docs/a.md' })])
    // A folder with no Markdown only reaches the tree when the user asks to see all folders.
    folderDirs = ['/docs/empty']
    useUIStore.getState().setShowAllFolders(true)
    useUIStore.getState().setActiveFolder('/docs')
    mount()
    fireEvent.contextMenu(screen.getByTestId('folder-row'))
    fireEvent.click(await screen.findByTestId('side-new-subfolder'))
    // Nothing precedes it inside the folder, so the temporary row is that list's whole content.
    expect(rowSequence()).toEqual(['/docs/empty', 'folder-create-row', '/docs/a.md'])
  })
})

describe('Sidebar — folder filtering & tree-area menu', () => {
  const docA = (): Document => ({
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
  })

  beforeEach(() => {
    allDocs.length = 0
    allDocs.push(docA())
    folderDirs = []
    useUIStore.getState().setActiveFolder('/docs')
    useUIStore.getState().setActiveDocumentId(null)
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

  it('shows the toolbar toggle while a folder is open', async () => {
    mount()
    expect(await screen.findByTestId('show-all-folders-btn')).toBeInTheDocument()
  })

  it('hides the toolbar toggle when no folder is open', async () => {
    useUIStore.getState().setActiveFolder(null)
    mount()
    await waitFor(() => expect(screen.queryByTestId('show-all-folders-btn')).toBeNull())
  })

  it('flips the flag from the toolbar toggle', async () => {
    mount()
    fireEvent.click(await screen.findByTestId('show-all-folders-btn'))
    await waitFor(() => expect(useUIStore.getState().showAllFolders).toBe(true))
    fireEvent.click(screen.getByTestId('show-all-folders-btn'))
    await waitFor(() => expect(useUIStore.getState().showAllFolders).toBe(false))
  })

  it('offers create + filter items in the tree-area background menu', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    for (const id of ['side-bg-new-folder', 'side-bg-new-file', 'side-bg-show-all-folders']) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('starts a folder create from the tree-area background menu', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-folder'))
    expect(await screen.findByTestId('folder-create-row')).toBeInTheDocument()
  })

  it('focuses the new-folder input on open so the user can type straight away', async () => {
    // Without this the row renders an empty input that is not focused: the user has to click
    // it before typing, and clicking a narrow row mid-list is easy to miss.
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-folder'))
    const input = within(await screen.findByTestId('folder-create-row')).getByTestId(
      'folder-name-input',
    )
    await waitFor(() => expect(input).toHaveFocus())
  })

  it('gives up instead of spinning forever when the input can never take focus', async () => {
    // focus() can be swallowed (the real case: the context menu has not finished closing), so
    // the grab retries — but a permanently unfocusable input must not reschedule endlessly.
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(() => {})
    // The frames are driven MANUALLY instead of letting the machine draw them: the previous
    // assertion counted how many frames happened to land in 200ms, which is a load-dependent
    // number, not a property of the code.
    const queue: FrameRequestCallback[] = []
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        queue.push(cb)
        return queue.length
      })
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-folder'))
    await screen.findByTestId('folder-create-row')
    await waitFor(() => expect(queue.length).toBeGreaterThan(0))
    // Run the retry loop one frame at a time until it stops asking for more.
    let drained = 0
    while (queue.length > 0 && drained < 100) {
      const cb = queue.shift()!
      drained++
      await act(async () => {
        cb(performance.now())
      })
    }
    // Bounded (Sidebar.tsx caps this grab at 8 retries)…
    expect(drained).toBeGreaterThan(0)
    expect(drained).toBeLessThanOrEqual(8)
    // …and — the actual anti-bug property — it STOPPED: an input that can never take focus
    // must not reschedule a frame loop for the lifetime of the row.
    expect(queue.length).toBe(0)
    focusSpy.mockRestore()
    rafSpy.mockRestore()
  })

  it('stops trying to refocus a renamed row that never reappears', async () => {
    // The focus-grab effect retries for a few rAF frames waiting for the renamed row to land,
    // then falls back to clearing focusPath (the `else setFocusPath(null)` branch) instead of
    // rescheduling forever. Renaming the real file row to a path the static tree never gains
    // means the row is never found, so the fallback runs. No shared fixture is mutated.
    // Same manual frame driver as above: `expect(frames within 400ms >= 10)` measured the
    // machine's frame rate and flaked at 9 under a full-suite run.
    const queue: FrameRequestCallback[] = []
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        queue.push(cb)
        return queue.length
      })
    mount()
    const row = screen.getByTestId('doc-item')
    row.focus()
    fireEvent.keyDown(row, { key: 'F2' })
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'renamed.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameFileMock).toHaveBeenCalled())
    await waitFor(() => expect(queue.length).toBeGreaterThan(0))
    // Drive the loop to exhaustion so the `else setFocusPath(null)` fallback runs.
    let drained = 0
    while (queue.length > 0 && drained < 100) {
      const cb = queue.shift()!
      drained++
      await act(async () => {
        cb(performance.now())
      })
    }
    // Bounded (Sidebar.tsx caps this grab at 10 retries)…
    expect(drained).toBeGreaterThan(0)
    expect(drained).toBeLessThanOrEqual(10)
    // …and it gave up instead of rescheduling forever.
    expect(queue.length).toBe(0)
    rafSpy.mockRestore()
  })

  it('names a new folder / file in the font size of the row it is naming', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-folder'))
    const folderRow = await screen.findByTestId('folder-create-row')
    expect(within(folderRow).getByTestId('folder-name-input').className).toContain('text-base')

    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const fileRow = await screen.findByTestId('file-create-row')
    // File names are listed at `text-xs`, so naming a file stays at `text-xs`.
    expect(within(fileRow).getByTestId('folder-name-input').className).toContain('text-xs')
  })

  it('toggles the flag from the background menu checkbox', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-show-all-folders'))
    await waitFor(() => expect(useUIStore.getState().showAllFolders).toBe(true))
  })

  it('fills ".md" on a bare name and waits for a second Enter to create', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'notes' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // First Enter refuses a name with no extension: it fills ".md" and explains, but writes nothing.
    await waitFor(() => expect(input).toHaveValue('notes.md'))
    expect(await within(row).findByTestId('file-name-hint')).toHaveTextContent('.md')
    expect(createMock).not.toHaveBeenCalled()
    // A second Enter (now with an extension) creates the file.
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'notes',
          ext: '.md',
          folderPath: '/docs',
          memoryOnly: false,
        }),
      ),
    )
  })

  it('fills ".md" on a bare name during a RENAME too, and holds the commit', async () => {
    mount()
    const item = screen.getByTestId('doc-item')
    item.focus()
    fireEvent.keyDown(item, { key: 'F2' })
    const input = await screen.findByTestId('folder-name-input')
    // The bare-name rule is not create-only: renaming to a stem with no extension also has to be
    // completed before it is committed, and must say why instead of silently dropping the ".md".
    fireEvent.change(input, { target: { value: 'a2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(input).toHaveValue('a2.md'))
    const row = screen.getByTestId('file-rename-row')
    expect(await within(row).findByTestId('file-name-hint')).toHaveTextContent('.md')
    expect(renameFileMock).not.toHaveBeenCalled()
    // A second Enter commits the rename.
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameFileMock).toHaveBeenCalled())
  })

  it('shows a note when the main process refuses the new file (EEXIST)', async () => {
    createMock.mockRejectedValueOnce(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }))
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'brandnew.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const hint = await within(row).findByTestId('file-name-hint')
    expect(hint.textContent).toBe(t('sidebar.nameExists', { name: 'brandnew.md' }))
    // The row stays open rather than losing what the user typed.
    expect(screen.queryByTestId('file-create-row')).not.toBeNull()
  })

  it('blocks a duplicate file name live (red border) and refuses Enter', async () => {
    allDocs.push({
      ...docA(),
      id: 'n',
      title: 'notes',
      filePath: '/docs/notes.md',
      folderPath: '/docs',
    })
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    // An empty name is never a clash.
    fireEvent.change(input, { target: { value: '' } })
    expect(within(row).queryByTestId('file-name-hint')).toBeNull()
    fireEvent.change(input, { target: { value: 'notes' } })
    // "notes" resolves to "notes.md", which already exists here — flagged live, before any commit.
    const hint = await within(row).findByTestId('file-name-hint')
    expect(hint).toHaveTextContent('already exists')
    expect(input.className).toContain('border-red-500')
    // Enter is refused until the name is unique.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(createMock).not.toHaveBeenCalled()
    // Fixing the name (with an extension) clears the error and commits.
    fireEvent.change(input, { target: { value: 'notes2.md' } })
    expect(within(row).queryByTestId('file-name-hint')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'notes2' })),
    )
  })

  it('blocks a duplicate folder name live too', async () => {
    allDocs.push({
      ...docA(),
      id: 'n',
      title: 'notes',
      filePath: '/docs/notes.md',
      folderPath: '/docs',
    })
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-folder'))
    const row = await screen.findByTestId('folder-create-row')
    const input = within(row).getByTestId('folder-name-input')
    // A folder "notes.md" would sit next to the existing file "notes.md".
    fireEvent.change(input, { target: { value: 'notes.md' } })
    const hint = await within(row).findByTestId('file-name-hint')
    expect(hint).toHaveTextContent('already exists')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(createFolderMock).not.toHaveBeenCalled()
  })

  it('flags a folder name carrying a separator live (VS Code-style invalid-name rule)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-folder'))
    const row = await screen.findByTestId('folder-create-row')
    const input = within(row).getByTestId('folder-name-input')
    // `a/b` could never be created (mkdir is non-recursive now), so it is refused as it is typed
    // instead of failing the commit with a generic "could not create".
    fireEvent.change(input, { target: { value: 'a/b' } })
    const hint = await within(row).findByTestId('file-name-hint')
    expect(hint.textContent).toBe(t('sidebar.invalidName', { name: 'a/b' }))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(createFolderMock).not.toHaveBeenCalled()
    // An ordinary name clears the flag again.
    fireEvent.change(input, { target: { value: 'plain' } })
    expect(within(row).queryByTestId('file-name-hint')).toBeNull()
  })

  it('flags a name differing only in case on a case-insensitive platform (VS Code rule)', async () => {
    // On Windows/macOS `Notes.md` IS `notes.md`, so the clash must be caught live rather than
    // left for the main process to reject after the commit.
    setUserAgent(WINDOWS_UA)
    try {
      allDocs.push({
        ...docA(),
        id: 'n',
        title: 'notes',
        filePath: '/docs/notes.md',
        folderPath: '/docs',
      })
      mount()
      fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
      fireEvent.click(await screen.findByTestId('side-bg-new-file'))
      const row = await screen.findByTestId('file-create-row')
      const input = within(row).getByTestId('folder-name-input')
      fireEvent.change(input, { target: { value: 'Notes' } })
      const hint = await within(row).findByTestId('file-name-hint')
      expect(hint).toHaveTextContent('already exists')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(createMock).not.toHaveBeenCalled()
    } finally {
      restoreUserAgent()
    }
  })

  it('lets a rename keep its own name in a different case on a case-insensitive platform', async () => {
    // `a.md` -> `A.md` is the same file there: the self-exclusion has to fold case too, or the
    // rename would report a clash with itself.
    setUserAgent(WINDOWS_UA)
    try {
      mount()
      const item = screen.getByTestId('doc-item')
      item.focus()
      fireEvent.keyDown(item, { key: 'F2' })
      const input = await screen.findByTestId('folder-name-input')
      fireEvent.change(input, { target: { value: 'A.md' } })
      expect(
        within(screen.getByTestId('file-rename-row')).queryByTestId('file-name-hint'),
      ).toBeNull()
    } finally {
      restoreUserAgent()
    }
  })

  it('accepts a case-only difference on a case-sensitive platform (Linux)', async () => {
    setUserAgent(LINUX_UA)
    try {
      allDocs.push({
        ...docA(),
        id: 'n',
        title: 'notes',
        filePath: '/docs/notes.md',
        folderPath: '/docs',
      })
      mount()
      fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
      fireEvent.click(await screen.findByTestId('side-bg-new-file'))
      const row = await screen.findByTestId('file-create-row')
      const input = within(row).getByTestId('folder-name-input')
      // On Linux these are two different files, so nothing must be flagged.
      fireEvent.change(input, { target: { value: 'Notes' } })
      await waitFor(() => expect(within(row).queryByTestId('file-name-hint')).toBeNull())
      fireEvent.keyDown(input, { key: 'Enter' })
      // The bare stem is completed first, so wait for the row to show it before committing.
      await waitFor(() => expect(input).toHaveValue('Notes.md'))
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>
        expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Notes' })),
      )
    } finally {
      restoreUserAgent()
    }
  })

  it('validates a name inside a NESTED folder (the recursive TreeRow keeps its validator)', async () => {
    // A folder at depth ≥ 1 renders through the RECURSIVE <TreeRow>, which has to forward the
    // clash validator down: without it the rename input has no `nameExists` and throws the moment
    // it validates a keystroke.
    allDocs.push(
      { ...docA(), id: 'x', folderPath: '/docs/sub/inner', filePath: '/docs/sub/inner/x.md' },
      { ...docA(), id: 'y', folderPath: '/docs/sub/other', filePath: '/docs/sub/other/y.md' },
    )
    mount()
    // Expand 'sub' so both nested folders — and the recursive rows that render them — exist.
    await userEvent.click(await screen.findByText('sub'))
    const inner = (await screen.findAllByTestId('folder-row')).find((row) =>
      row.textContent?.includes('inner'),
    )
    fireEvent.contextMenu(inner!)
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    // 'other' is 'inner's sibling under '/docs/sub', so renaming onto it must be flagged live.
    fireEvent.change(input, { target: { value: 'other' } })
    const hint = await screen.findByTestId('file-name-hint')
    expect(hint).toHaveTextContent('already exists')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameFolderMock).not.toHaveBeenCalled()
  })

  it('does not flag a file rename that keeps its own name', async () => {
    mount()
    const item = screen.getByTestId('doc-item')
    item.focus()
    fireEvent.keyDown(item, { key: 'F2' })
    const input = await screen.findByTestId('folder-name-input')
    // Renaming "a.md" to "a" resolves to "a.md", its own current name — must not be a clash.
    fireEvent.change(input, { target: { value: 'a' } })
    expect(within(screen.getByTestId('file-rename-row')).queryByTestId('file-name-hint')).toBeNull()
  })

  it('strips a typed extension so the file never becomes notes.md.md', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'notes.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'notes' })),
    )
  })

  it('creates the file with the Markdown extension the user typed', async () => {
    // Typing notes.markdown must produce notes.markdown — the extension the user typed is the
    // one they get, `.md` is only filled in when they did not type one at all.
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'notes.markdown' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'notes', ext: '.markdown' }),
      ),
    )
  })

  it('refuses to create a file with an extension the app cannot open', async () => {
    // notes.txt could never be opened by this app, so the commit is refused rather than
    // silently written: nothing is created and the `.md` spelling is offered instead.
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'notes.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(input).toHaveValue('notes.md'))
    expect(createMock).not.toHaveBeenCalled()
  })

  it('explains a refused new-file name under the input', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'notes.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const hint = await within(row).findByTestId('file-name-hint')
    expect(hint.textContent).toContain('.txt')
  })

  it('cancels the new-file input on Escape without creating anything', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('file-create-row')).toBeNull())
    expect(createMock).not.toHaveBeenCalled()
  })

  it('drops the pin once a created folder holds a Markdown document', async () => {
    useUIStore.setState({ recentlyCreatedFolders: new Set(['/docs/sub']) })
    // b.md lives under /docs/sub, so the folder qualifies on its own and the pin is dead.
    allDocs.push({ ...docA(), id: 'b', filePath: '/docs/sub/b.md', folderPath: '/docs/sub' })
    mount()
    await waitFor(() => expect(useUIStore.getState().recentlyCreatedFolders.size).toBe(0))
  })

  it('opens the row menu without also opening the tree-area menu', async () => {
    mount()
    fireEvent.contextMenu(await screen.findByTestId('doc-item'))
    expect(await screen.findByTestId('side-open-document')).toBeInTheDocument()
    expect(screen.queryByTestId('side-bg-new-folder')).toBeNull()
  })

  it('creates a folder from the empty-state menu', async () => {
    allDocs.length = 0 // no documents at all: the sidebar falls back to the empty state
    mount()
    fireEvent.contextMenu(await screen.findByTestId('sidebar-empty-state'))
    fireEvent.click(await screen.findByTestId('side-empty-new-folder'))
    // The row has to appear even though the tree is empty, otherwise the menu item would
    // set the edit state and show nothing — looking completely broken.
    const row = await screen.findByTestId('folder-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createFolderMock).toHaveBeenCalled())
  })

  it('drops the pin when a deeper descendant gains a Markdown document', async () => {
    useUIStore.setState({ recentlyCreatedFolders: new Set(['/docs/sub']) })
    // c.md sits two levels below the pinned folder, so only the prefix match finds it.
    allDocs.push({
      ...docA(),
      id: 'c',
      filePath: '/docs/sub/deep/c.md',
      folderPath: '/docs/sub/deep',
    })
    mount()
    await waitFor(() => expect(useUIStore.getState().recentlyCreatedFolders.size).toBe(0))
  })

  it('keeps a just-created folder visible after renaming it (the pin follows the rename)', async () => {
    // 'fresh' was created this session and is still empty, so it only shows because it is
    // pinned. Renaming must move the pin to the new path: an empty folder that loses its
    // pin is filtered straight back out and simply disappears.
    useUIStore.setState({ recentlyCreatedFolders: new Set(['/docs/fresh']) })
    folderDirs = ['/docs/fresh']
    // Mirror what a refetch would do: the on-disk listing now carries the new name.
    renameFolderMock.mockImplementation(async () => {
      folderDirs = ['/docs/renamed']
      return {}
    })
    mount()
    fireEvent.contextMenu(await screen.findByText('fresh'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameFolderMock).toHaveBeenCalled())
    expect(useUIStore.getState().recentlyCreatedFolders).toContain('/docs/renamed')
    await waitFor(() => expect(screen.getByText('renamed')).toBeInTheDocument())
  })

  it('leaves an unrelated pin alone when another folder is renamed', async () => {
    // The pin belongs to a different folder, so renaming this one must not touch it.
    useUIStore.setState({ recentlyCreatedFolders: new Set(['/docs/other']) })
    allDocs.push({ ...docA(), id: 'b', filePath: '/docs/sub/b.md', folderPath: '/docs/sub' })
    mount()
    fireEvent.contextMenu(await screen.findByText('sub'))
    fireEvent.click(await screen.findByTestId('side-rename-folder'))
    const input = await screen.findByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameFolderMock).toHaveBeenCalled())
    expect([...useUIStore.getState().recentlyCreatedFolders]).toEqual(['/docs/other'])
  })

  it('surfaces a failed file create without crashing', async () => {
    createMock.mockRejectedValueOnce(new Error('boom'))
    mount()
    fireEvent.contextMenu(screen.getByTestId('sidebar-tree-area'))
    fireEvent.click(await screen.findByTestId('side-bg-new-file'))
    const row = await screen.findByTestId('file-create-row')
    const input = within(row).getByTestId('folder-name-input')
    fireEvent.change(input, { target: { value: 'notes.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createMock).toHaveBeenCalled())
    // The input stays open, so what the user typed is not lost.
    expect(screen.getByTestId('file-create-row')).toBeInTheDocument()
  })
})
