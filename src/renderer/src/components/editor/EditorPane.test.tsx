import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor, act, fireEvent, screen } from '@testing-library/react'
import { TooltipProvider } from '../ui/tooltip'
import { EditorPane } from './EditorPane'
import { useUIStore } from '../../store/ui'
import '../../i18n'

// Share a few refs between the mocked hooks and the assertions (vi.hoisted so the
// mock factory can reference them despite hoisting).
const h = vi.hoisted(() => ({
  startTitleEdit: vi.fn(),
  isLoading: false,
  filePath: '/a.md',
  editingTitle: false,
}))

vi.mock('../../hooks/useDocuments', () => ({
  useDocument: () => ({
    data: { id: 'a', filePath: h.filePath, title: 'a', content: '# A', missing: false },
    isLoading: h.isLoading,
  }),
  useUpdateDocument: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => ({
      id: 'a',
      title: 'a',
      filePath: '/a.md',
      content: '# A',
      missing: false,
    })),
  }),
  useOpenPaths: () => ({ mutate: vi.fn(), isPending: false }),
  useOpenFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveDocumentAs: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => null),
    isPending: false,
  }),
  useReloadDocument: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => ({
      id: 'a',
      title: 'a',
      filePath: '/a.md',
      content: '# A',
      missing: false,
    })),
    isPending: false,
  }),
}))

vi.mock('../../hooks/useLocalDocument', () => ({
  useLocalDocument: () => ({
    localContent: '# A',
    localTitle: 'a.md',
    setLocalTitle: vi.fn(),
    editingTitle: h.editingTitle,
    startTitleEdit: h.startTitleEdit,
    cancelTitleEdit: vi.fn(),
    handleContentChange: vi.fn(),
    handleTitleSave: vi.fn(),
    dirty: false,
    markSaved: vi.fn(),
    toDiskFormat: vi.fn(),
    getEol: vi.fn(),
  }),
}))

// Avoid spinning up the parse Worker (undefined in jsdom) during EditorPane's preview render.
vi.mock('../../lib/parseClient', () => ({
  parseMarkdown: vi.fn(async () => ({ html: '', mermaid: [], headings: [], toc: [] })),
  warmupParseWorker: vi.fn(),
}))

beforeEach(() => {
  h.startTitleEdit.mockClear()
  h.isLoading = false
  h.filePath = '/a.md'
  h.editingTitle = false
  useUIStore.getState().setActiveDocumentId('a')
  useUIStore.getState().setEditable(true)
  useUIStore.getState().requestFileAction(null)
  ;(window as unknown as { api: unknown }).api = {
    onMenuEvent: vi.fn(() => () => {}),
    onFileChanged: vi.fn(() => () => {}),
    dialog: { confirm: vi.fn(async () => true), saveFile: vi.fn(async () => null) },
    app: { showInFolder: vi.fn(async () => {}) },
    documents: { eol: vi.fn(async () => '\n') },
    export: { print: vi.fn(async () => {}) },
    clipboard: { writeText: vi.fn(async () => {}) },
  }
})

function mount() {
  return render(
    <TooltipProvider>
      <EditorPane />
    </TooltipProvider>,
  )
}

describe('EditorPane pendingFileAction rename (PLAN §5.1)', () => {
  it('enters title-edit when rename is requested for the active, loaded, editable doc', async () => {
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'rename', id: 'a' })
    })
    await waitFor(() => expect(h.startTitleEdit).toHaveBeenCalled())
    // The request is consumed (cleared) after handling.
    expect(useUIStore.getState().pendingFileAction).toBeNull()
  })

  it('does nothing when the pending id is not the active document', async () => {
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'rename', id: 'other' })
    })
    await waitFor(() => {})
    expect(h.startTitleEdit).not.toHaveBeenCalled()
    // A mismatched id is left pending (not silently discarded).
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'rename', id: 'other' })
  })

  it('does not enter title-edit while the document is still loading', async () => {
    h.isLoading = true
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'rename', id: 'a' })
    })
    await waitFor(() => {})
    expect(h.startTitleEdit).not.toHaveBeenCalled()
  })

  it('clears the pending rename (without editing) in read-only mode', async () => {
    useUIStore.getState().setEditable(false)
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'rename', id: 'a' })
    })
    await waitFor(() => expect(useUIStore.getState().pendingFileAction).toBeNull())
    expect(h.startTitleEdit).not.toHaveBeenCalled()
  })
})

describe('EditorPane pendingFileAction save / saveAs / reload (能力 6)', () => {
  it('saves when a save is requested for the active, editable, loaded doc', async () => {
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'save' })
    })
    await waitFor(() => expect(useUIStore.getState().pendingFileAction).toBeNull())
  })

  it('runs Save As when requested', async () => {
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'saveAs' })
    })
    await waitFor(() => expect(useUIStore.getState().pendingFileAction).toBeNull())
  })

  it('reloads when requested', async () => {
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'reload' })
    })
    await waitFor(() => expect(useUIStore.getState().pendingFileAction).toBeNull())
  })

  it('clears a save request in read-only mode without saving', async () => {
    useUIStore.getState().setEditable(false)
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'save' })
    })
    await waitFor(() => expect(useUIStore.getState().pendingFileAction).toBeNull())
    expect(window.api.dialog.saveFile).not.toHaveBeenCalled()
  })

  it('ignores a save request while the document is still loading', async () => {
    h.isLoading = true
    mount()
    act(() => {
      useUIStore.getState().requestFileAction({ type: 'save' })
    })
    await waitFor(() => {})
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'save' })
  })
})

describe('EditorPane file context menus (PLAN §5.6 / §5.7)', () => {
  it('title-bar right-click shows the shared file menu', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    for (const id of [
      'ctx-rename',
      'ctx-copy-filename',
      'ctx-copy-path',
      'ctx-show-in-folder',
      'ctx-save',
      'ctx-save-as',
      'ctx-reload',
      'ctx-details',
      'ctx-export-html',
    ]) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('title menu rename delegates to startTitleEdit', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    fireEvent.click(await screen.findByTestId('ctx-rename'))
    expect(h.startTitleEdit).toHaveBeenCalled()
  })

  it('title menu copies the full path to the clipboard', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    fireEvent.click(await screen.findByTestId('ctx-copy-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/a.md')
  })

  it('title menu opens the file-details dialog', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    fireEvent.click(await screen.findByTestId('ctx-details'))
    expect(useUIStore.getState().fileDetailsId).toBe('a')
  })

  it('last path segment shows the file submenu (no save block)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('path-last-segment'))
    expect(await screen.findByTestId('ctx-rename')).toBeInTheDocument()
    expect(await screen.findByTestId('ctx-details')).toBeInTheDocument()
    expect(screen.queryByTestId('ctx-save')).toBeNull()
    expect(screen.queryByTestId('ctx-save-as')).toBeNull()
  })

  it('folder icon shows reveal / copy full path / copy name', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('path-folder-icon'))
    expect(await screen.findByTestId('ctx-show-in-folder')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-copy-path')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-copy-filename')).toBeInTheDocument()
    // Icon variant has no rename / save / details.
    expect(screen.queryByTestId('ctx-rename')).toBeNull()
  })

  it('middle path segment offers open-in-sidebar / reveal / copy folder path', async () => {
    h.filePath = '/x/y/a.md'
    mount()
    const segments = screen.getAllByTestId('path-folder-segment')
    expect(segments).toHaveLength(2) // 'x' and 'y'
    // Right-click the inner folder 'y'.
    fireEvent.contextMenu(segments[1])
    fireEvent.click(await screen.findByTestId('ctx-open-folder-in-sidebar'))
    expect(useUIStore.getState().activeFolder).toBe('/x/y')

    fireEvent.contextMenu(segments[1])
    fireEvent.click(await screen.findByTestId('ctx-copy-folder-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/x/y')

    fireEvent.contextMenu(segments[1])
    fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/x/y')
  })

  it('rename input exposes the edit context menu while the title is being edited', async () => {
    h.editingTitle = true
    mount()
    const input = document.querySelector('input') as HTMLInputElement
    fireEvent.contextMenu(input)
    expect(await screen.findByTestId('ctx-undo')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-select-all')).toBeInTheDocument()
    h.editingTitle = false
  })

  it('title menu covers every file action (PLAN §5.6)', async () => {
    useUIStore.getState().setDirty(true)
    mount()
    const open = () => fireEvent.contextMenu(screen.getByTestId('title-btn'))

    open()
    fireEvent.click(await screen.findByTestId('ctx-copy-filename'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('a.md')

    open()
    fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/a.md')

    // save / save-as / reload are exercised for coverage (each re-opens the menu).
    open()
    fireEvent.click(await screen.findByTestId('ctx-save'))
    // The save handler reaches the on-disk eol IPC (the bug: window.api.documents
    // was undefined, throwing an unhandled rejection before this was called).
    expect(window.api.documents.eol).toHaveBeenCalledWith('/a.md')
    open()
    fireEvent.click(await screen.findByTestId('ctx-save-as'))
    // saveFile runs after the `await eol(...)` microtask, so wait for it.
    await waitFor(() => expect(window.api.dialog.saveFile).toHaveBeenCalled())
    open()
    fireEvent.click(await screen.findByTestId('ctx-reload'))

    open()
    fireEvent.click(await screen.findByTestId('ctx-export-html'))
    expect(useUIStore.getState().exportOpen).toBe(true)
  })

  it('middle path segment resolves Windows-style absolute paths', async () => {
    h.filePath = 'C:\\docs\\sub\\a.md'
    mount()
    const segments = screen.getAllByTestId('path-folder-segment')
    // 'C:' / 'docs' / 'sub' are folders; 'a.md' is the last (file) segment.
    expect(segments).toHaveLength(3)
    fireEvent.contextMenu(segments[0])
    fireEvent.click(await screen.findByTestId('ctx-open-folder-in-sidebar'))
    expect(useUIStore.getState().activeFolder).toBe('C:/')
    fireEvent.contextMenu(segments[2])
    fireEvent.click(await screen.findByTestId('ctx-open-folder-in-sidebar'))
    expect(useUIStore.getState().activeFolder).toBe('C:/docs/sub')
  })

  it('swallows a rejected reveal without surfacing an unhandled rejection', async () => {
    ;(window.api.app.showInFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('no folder'),
    )
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).toHaveBeenCalledWith('/a.md'))
  })
})
