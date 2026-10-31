import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor, act, fireEvent, screen } from '@testing-library/react'
import { FileText, Search } from 'lucide-react'
import { TooltipProvider } from '../ui/tooltip'
import { EditorPane } from './EditorPane'
import { useUIStore } from '../../store/ui'
import '../../i18n'

// Share a few refs between the mocked hooks and the assertions (vi.hoisted so the
// mock factory can reference them despite hoisting).
const h = vi.hoisted(() => ({
  startTitleEdit: vi.fn(),
  isLoading: false,
  // Flip to simulate the state where the document record is gone.
  noDoc: false,
  filePath: '/a.md',
  editingTitle: false,
}))

vi.mock('../../hooks/useDocuments', () => ({
  useDocument: () => ({
    data: h.noDoc
      ? undefined
      : { id: 'a', filePath: h.filePath, title: 'a', content: '# A', missing: false },
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
  h.noDoc = false
  h.filePath = '/a.md'
  h.editingTitle = false
  useUIStore.getState().setActiveDocumentId('a')
  useUIStore.getState().setEditable(true)
  useUIStore.getState().setPendingMatch(null)
  // Reset the export lock: closeDocument/closeWorkspace are hard-locked while it is set,
  // and the export menu test below leaves it on.
  useUIStore.getState().setExportOpen(false)
  useUIStore.getState().setExporting(false)
  useUIStore.getState().requestFileAction(null)
  ;(window as unknown as { api: unknown }).api = {
    onMenuEvent: vi.fn(() => () => {}),
    onFileChanged: vi.fn(() => () => {}),
    dialog: {
      confirm: vi.fn(async () => true),
      saveFile: vi.fn(async () => null),
      openFiles: vi.fn(async () => ['/x.md']),
      openFolderPath: vi.fn(async () => null),
    },
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

it('jumps the editor to a pending search hit and then clears it (Phase 4)', async () => {
  useUIStore.getState().setPendingMatch({ id: 'a', start: 2, end: 3 })
  mount()
  // MarkdownEditor applies the offset and calls back, clearing pendingMatch.
  await waitFor(() => expect(useUIStore.getState().pendingMatch).toBeNull())
})

// D22 / §6 step 9: the Quick Open trigger lives in the editor's CommonToolbar, next to the
// sidebar toggle — and the shortcut chip is ALWAYS visible, not just inside the tooltip.
describe('EditorPane — Quick Open trigger (D22)', () => {
  it('renders the trigger with its shortcut chip when a document is open', () => {
    mount()
    expect(screen.getByTestId('editor-goto-file-btn')).toBeTruthy()
    expect(screen.getByTestId('editor-goto-file-chip').textContent).toMatch(/K/)
  })

  it('renders the trigger with NO document open (empty state)', () => {
    // ⌘K is how you get INTO a keyboard-first app: the entry point cannot depend on a
    // document already being open (§6 step 9 — the row renders in both states).
    h.noDoc = true
    useUIStore.getState().setActiveDocumentId(null)
    mount()
    expect(screen.getByTestId('editor-goto-file-btn')).toBeTruthy()
    expect(screen.getByTestId('editor-goto-file-chip')).toBeTruthy()
    useUIStore.getState().setActiveDocumentId('a')
    h.noDoc = false
  })

  it('opens the Quick Open modal when clicked', () => {
    mount()
    expect(useUIStore.getState().searchOpen).toBe(false)
    fireEvent.click(screen.getByTestId('editor-goto-file-btn'))
    expect(useUIStore.getState().searchOpen).toBe(true)
  })

  // PLAN C6 (R5): Quick Open must NOT wear a magnifier — it sits one icon away from the
  // in-document find button (⌘F), and two adjacent magnifiers read as the same action.
  // Compared against the icon library's OWN output rather than a class name, so a lucide
  // upgrade cannot quietly turn this into a no-op assertion.
  it('uses a document glyph, not a magnifier, for the Quick Open trigger', () => {
    const magnifier = render(<Search size={16} />).container.querySelector('svg')!
    const docGlyph = render(<FileText size={16} />).container.querySelector('svg')!
    mount()
    const icon = screen.getByTestId('editor-goto-file-btn').querySelector('svg')!
    expect(icon.outerHTML).toBe(docGlyph.outerHTML)
    expect(icon.outerHTML).not.toBe(magnifier.outerHTML)
    // PLAN C23 / ADR-0024 §1.3: chrome main controls wear 16px icons.
    expect(icon.getAttribute('width')).toBe('16')
    expect(icon.getAttribute('height')).toBe('16')
  })
})

// PLAN C8: with no document open, the read-only / edit choice has no meaning — and the
// divider that precedes it must be wrapped with it, or the empty state ends in a lone
// vertical line.
describe('EditorPane — read-only toggle', () => {
  it('hides the read-only / edit toggle while no document is open', () => {
    h.noDoc = true
    useUIStore.getState().setActiveDocumentId(null)
    mount()
    expect(screen.queryByTestId('editor-readonly-btn')).toBeNull()
  })

  it('shows the read-only / edit toggle once a document is open', () => {
    mount()
    expect(screen.getByTestId('editor-readonly-btn')).toBeTruthy()
  })
})

// C20 / ADR-0024 §10 trade-off 46: "Export HTML" is ONE action whose entry point follows the
// preview's visibility — preview visible ⇒ preview bar; edit-only ⇒ global bar. Only one export
// button is ever on screen: two peer toolbars must not carry the same button side by side.
describe('EditorPane — export button placement (C20)', () => {
  it('shows exactly one export button and moves it with the preview visibility', () => {
    act(() => {
      useUIStore.getState().setViewMode('edit')
    })
    mount()
    expect(screen.getAllByTestId('export-btn')).toHaveLength(1)
    // Edit-only has no visible preview to inspect, so the entry stays on the global bar.
    expect(screen.getByTestId('export-btn').closest('[data-testid="preview-pane"]')).toBeNull()

    act(() => {
      useUIStore.getState().setViewMode('split')
    })
    const btn = screen.getByTestId('export-btn')
    // Preview visible ⇒ the action sits next to the live rendering it exports.
    expect(screen.getAllByTestId('export-btn')).toHaveLength(1)
    expect(btn.closest('[data-testid="preview-pane"]')).not.toBeNull()
  })
})

describe('EditorPane pendingFileAction rename', () => {
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

describe('EditorPane file context menus', () => {
  it('title-bar right-click shows the shared file menu', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    for (const id of [
      'doc-rename',
      'doc-copy-filename',
      'doc-copy-path',
      'doc-show-in-folder',
      'doc-save',
      'doc-save-as',
      'doc-reload',
      'doc-details',
      'doc-export-html',
    ]) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('title menu rename delegates to startTitleEdit', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    fireEvent.click(await screen.findByTestId('doc-rename'))
    expect(h.startTitleEdit).toHaveBeenCalled()
  })

  it('title menu copies the full path to the clipboard', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    fireEvent.click(await screen.findByTestId('doc-copy-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/a.md')
  })

  it('title menu opens the file-details dialog', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    fireEvent.click(await screen.findByTestId('doc-details'))
    expect(useUIStore.getState().fileDetailsId).toBe('a')
  })

  it('last path segment shows the file submenu (no save block)', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('path-last-segment'))
    expect(await screen.findByTestId('doc-rename')).toBeInTheDocument()
    expect(await screen.findByTestId('doc-details')).toBeInTheDocument()
    expect(screen.queryByTestId('doc-save')).toBeNull()
    expect(screen.queryByTestId('doc-save-as')).toBeNull()
  })

  it('folder icon shows reveal / copy full path / copy name', async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('path-folder-icon'))
    expect(await screen.findByTestId('doc-show-in-folder')).toBeInTheDocument()
    expect(screen.getByTestId('doc-copy-path')).toBeInTheDocument()
    expect(screen.getByTestId('doc-copy-filename')).toBeInTheDocument()
    // Icon variant has no rename / save / details.
    expect(screen.queryByTestId('doc-rename')).toBeNull()
  })

  it('middle path segment offers open-in-sidebar / reveal / copy folder path', async () => {
    h.filePath = '/x/y/a.md'
    mount()
    const segments = screen.getAllByTestId('path-folder-segment')
    expect(segments).toHaveLength(2) // 'x' and 'y'
    // Right-click the inner folder 'y'.
    fireEvent.contextMenu(segments[1])
    fireEvent.click(await screen.findByTestId('doc-open-folder-in-sidebar'))
    expect(useUIStore.getState().activeFolder).toBe('/x/y')

    fireEvent.contextMenu(segments[1])
    fireEvent.click(await screen.findByTestId('doc-copy-folder-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/x/y')

    fireEvent.contextMenu(segments[1])
    fireEvent.click(await screen.findByTestId('doc-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/x/y')
  })

  it('rename input exposes the edit context menu while the title is being edited', async () => {
    h.editingTitle = true
    mount()
    const input = document.querySelector('input') as HTMLInputElement
    fireEvent.contextMenu(input)
    expect(await screen.findByTestId('input-undo')).toBeInTheDocument()
    expect(screen.getByTestId('input-select-all')).toBeInTheDocument()
    h.editingTitle = false
  })

  it('title menu covers every file action', async () => {
    useUIStore.getState().setDirty(true)
    mount()
    const open = () => fireEvent.contextMenu(screen.getByTestId('title-btn'))

    open()
    fireEvent.click(await screen.findByTestId('doc-copy-filename'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('a.md')

    open()
    fireEvent.click(await screen.findByTestId('doc-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/a.md')

    // save / save-as / reload are exercised for coverage (each re-opens the menu).
    open()
    fireEvent.click(await screen.findByTestId('doc-save'))
    // The save handler reaches the on-disk eol IPC (the bug: window.api.documents
    // was undefined, throwing an unhandled rejection before this was called).
    expect(window.api.documents.eol).toHaveBeenCalledWith('/a.md')
    open()
    fireEvent.click(await screen.findByTestId('doc-save-as'))
    // saveFile runs after the `await eol(...)` microtask, so wait for it.
    await waitFor(() => expect(window.api.dialog.saveFile).toHaveBeenCalled())
    open()
    fireEvent.click(await screen.findByTestId('doc-reload'))

    open()
    fireEvent.click(await screen.findByTestId('doc-export-html'))
    expect(useUIStore.getState().exportOpen).toBe(true)
  })

  it('middle path segment resolves Windows-style absolute paths', async () => {
    h.filePath = 'C:\\docs\\sub\\a.md'
    mount()
    const segments = screen.getAllByTestId('path-folder-segment')
    // 'C:' / 'docs' / 'sub' are folders; 'a.md' is the last (file) segment.
    expect(segments).toHaveLength(3)
    fireEvent.contextMenu(segments[0])
    fireEvent.click(await screen.findByTestId('doc-open-folder-in-sidebar'))
    expect(useUIStore.getState().activeFolder).toBe('C:/')
    fireEvent.contextMenu(segments[2])
    fireEvent.click(await screen.findByTestId('doc-open-folder-in-sidebar'))
    expect(useUIStore.getState().activeFolder).toBe('C:/docs/sub')
  })

  it('swallows a rejected reveal without surfacing an unhandled rejection', async () => {
    ;(window.api.app.showInFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('no folder'),
    )
    mount()
    fireEvent.contextMenu(screen.getByTestId('title-btn'))
    fireEvent.click(await screen.findByTestId('doc-show-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).toHaveBeenCalledWith('/a.md'))
  })
})

describe('EditorPane empty-state context menu', () => {
  it('offers create / search / open actions from the right-click menu', async () => {
    useUIStore.getState().setActiveDocumentId(null)
    mount()
    const empty = await screen.findByTestId('editor-empty-state')
    fireEvent.contextMenu(empty)
    fireEvent.click(await screen.findByTestId('ed-new-document'))
    expect(useUIStore.getState().newDocOpen).toBe(true)

    fireEvent.contextMenu(empty)
    fireEvent.click(await screen.findByTestId('ed-search-documents'))
    expect(useUIStore.getState().searchOpen).toBe(true)

    fireEvent.contextMenu(empty)
    fireEvent.click(await screen.findByTestId('ed-open-file'))
    expect(window.api.dialog.openFiles).toHaveBeenCalled()

    fireEvent.contextMenu(empty)
    fireEvent.click(await screen.findByTestId('ed-open-folder'))
    expect(window.api.dialog.openFolderPath).toHaveBeenCalled()
  })
})

describe('EditorPane missing-document state context menu', () => {
  it('offers close file / open file / open folder when the record is gone', async () => {
    h.noDoc = true
    mount()
    const missing = await screen.findByTestId('editor-missing-state')
    fireEvent.contextMenu(missing)
    fireEvent.click(await screen.findByTestId('ed-open-file'))
    await waitFor(() => expect(window.api.dialog.openFiles).toHaveBeenCalled())

    fireEvent.contextMenu(missing)
    fireEvent.click(await screen.findByTestId('ed-open-folder'))
    await waitFor(() => expect(window.api.dialog.openFolderPath).toHaveBeenCalled())

    // Closing last: it clears activeDocumentId, which swaps the missing state for the
    // empty state (and detaches `missing`).
    fireEvent.contextMenu(missing)
    fireEvent.click(await screen.findByTestId('ed-close-file'))
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })
})

describe('EditorPane split-divider context menu', () => {
  it('resets the split ratio and switches to the editor view', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    const divider = await screen.findByTestId('split-divider')
    fireEvent.contextMenu(divider)
    fireEvent.click(await screen.findByTestId('ed-reset-split'))
    fireEvent.contextMenu(divider)
    fireEvent.click(await screen.findByTestId('ed-view-editor'))
    expect(useUIStore.getState().viewMode).toBe('edit')
  })

  it('switches to the preview view from the divider menu', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    const divider = await screen.findByTestId('split-divider')
    fireEvent.contextMenu(divider)
    fireEvent.click(await screen.findByTestId('ed-view-preview'))
    expect(useUIStore.getState().viewMode).toBe('preview')
  })
})

describe('EditorPane in-pane find (Ctrl+F)', () => {
  it('opens the editor find panel from the toolbar find button', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    // Wait for the CodeMirror editor to mount.
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    fireEvent.click(screen.getByTestId('editor-find-btn'))
    // The markdown:find event opens CodeMirror's search panel.
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
  })

  it('hides the find button in pure preview mode', async () => {
    useUIStore.getState().setViewMode('preview')
    mount()
    expect(screen.queryByTestId('editor-find-btn')).toBeNull()
  })

  it('opens the editor find panel from a window-level Ctrl+F, with no editor focus', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    // Deliberately blur: the shortcut must not depend on the editor holding focus. It used to be
    // CodeMirror's own keymap only, so clicking the sidebar, the title bar or the preview left
    // Ctrl+F completely dead.
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
    // Ctrl/Cmd+F is find-ONLY (VS Code parity): the replace row stays collapsed even though the editor
    // is editable. Ctrl/Cmd+H is what reveals it.
    expect(screen.queryByTestId('editor-find-replace')).toBeNull()
  })

  it('routes Ctrl+F to the preview when the user last interacted with the preview pane (split mode)', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    // The preview pane is visible in split mode but is a NON-FOCUSABLE <div>: clicking it grants it
    // no focus, so routing by focus (or by viewMode alone) opened the editor's find even though the
    // user was in the preview. It must open the preview's find instead.
    fireEvent.pointerDown(screen.getByTestId('preview-pane'))
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId('preview-find-bar')).toBeInTheDocument())
    expect(document.querySelector('.cm-panel')).toBeNull()
  })

  it('routes Ctrl+F back to the editor after the user touches the editor pane (split mode)', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    // Touch the preview first so the pane tracking is exercised in both directions.
    fireEvent.pointerDown(screen.getByTestId('preview-pane'))
    fireEvent.pointerDown(screen.getByTestId('editor-pane'))
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
    expect(screen.queryByTestId('preview-find-bar')).toBeNull()
  })

  it('routes Ctrl+F to the editor in edit-only mode (the preview pane is hidden there)', async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    fireEvent.pointerDown(screen.getByTestId('editor-pane'))
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
    expect(screen.queryByTestId('preview-find-bar')).toBeNull()
  })

  it('stands down while a modal surface owns the keyboard (no find panel behind a dialog)', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    // What a Radix dialog puts in the DOM (see lib/shortcut-scope). While it is there the keyboard
    // belongs to the dialog: a background shortcut must not open a find panel hidden behind it.
    const modal = document.createElement('div')
    modal.setAttribute('data-modal-surface', '')
    document.body.appendChild(modal)

    // Dispatch manually so we can read defaultPrevented: standing down must NOT swallow the key.
    const findEvent = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(findEvent)
    const replaceEvent = new KeyboardEvent('keydown', {
      key: 'h',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(replaceEvent)
    expect(document.querySelector('.cm-panel')).toBeNull()
    expect(findEvent.defaultPrevented).toBe(false)
    expect(replaceEvent.defaultPrevented).toBe(false)

    // Once the modal closes the shortcut works again — and this time it DOES claim the key.
    modal.remove()
    const reopened = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(reopened)
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
    expect(reopened.defaultPrevented).toBe(true)
  })

  it("does not open find via CodeMirror's own Mod-f while a modal owns the keyboard", async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    const modal = document.createElement('div')
    modal.setAttribute('data-modal-surface', '')
    document.body.appendChild(modal)

    // Dispatch on the editor's content DOM — the event CodeMirror's keymap sees. A modal overlay
    // that does not trap focus (e.g. the command palette) leaves focus here, so with Mod-f still
    // bound in searchKeymap it would open the panel straight through the modal guard. Keep this:
    // it is the only test that fails if Mod-f is ever added back.
    const content = document.querySelector('.cm-content') as HTMLElement
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    content.dispatchEvent(ev)
    expect(document.querySelector('.cm-panel')).toBeNull()

    modal.remove()
  })

  it('focuses the editor find input once the panel has rendered', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    // CodeMirror's own attempt to focus `[main-field]` runs before React has committed the panel,
    // so it is a no-op; MarkdownEditor focuses it on the next frame instead. Without that, the
    // panel opens but the user's keystrokes land in the document.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('editor-find-input')),
    )
  })

  it('routes Ctrl+F to the preview find bar in pure preview mode', async () => {
    useUIStore.getState().setViewMode('preview')
    mount()
    await waitFor(() => expect(screen.getByTestId('preview-find-btn')).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId('preview-find-bar')).toBeInTheDocument())
  })

  it('ignores a keydown without the Ctrl/Cmd modifier', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'f' })
    expect(document.querySelector('.cm-panel')).toBeNull()
  })

  it('ignores Ctrl/Cmd with an unrelated key', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true })
    expect(document.querySelector('.cm-panel')).toBeNull()
  })

  it('opens the find panel via Cmd+F (macOS metaKey)', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
  })

  it('opens the replace panel from the toolbar replace button', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    fireEvent.click(screen.getByTestId('editor-replace-btn'))
    // The markdown:replace event opens the same CodeMirror search panel (which includes a replace field).
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
  })

  it('opens the replace panel on Ctrl+H', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'h', ctrlKey: true })
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
  })

  it('routes Shift+Ctrl+H to replace-all, not replace', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    const seen: string[] = []
    const listener = (e: Event) => {
      seen.push(e.type)
    }
    document.addEventListener('markdown:replaceAll', listener)
    document.addEventListener('markdown:replace', listener)
    fireEvent.keyDown(window, { key: 'h', ctrlKey: true, shiftKey: true })
    document.removeEventListener('markdown:replaceAll', listener)
    document.removeEventListener('markdown:replace', listener)
    expect(seen).toEqual(['markdown:replaceAll'])
  })

  it('hides the replace button in pure preview mode', async () => {
    useUIStore.getState().setViewMode('preview')
    mount()
    expect(screen.queryByTestId('editor-replace-btn')).toBeNull()
  })

  // ── G4 / G5 ─────────────────────────────────────────────────────────────
  it('leaves Ctrl+H a no-op in pure preview mode (editor unmounted — G4)', async () => {
    useUIStore.getState().setViewMode('preview')
    mount()
    await waitFor(() => expect(screen.getByTestId('preview-find-btn')).toBeInTheDocument())
    let replaced = false
    const onReplace = () => {
      replaced = true
    }
    window.addEventListener('markdown:replace', onReplace)
    const ev = new KeyboardEvent('keydown', {
      key: 'h',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(ev)
    // The editor is unmounted in preview-only mode, so replace has no target: stand down without
    // swallowing the key.
    expect(replaced).toBe(false)
    expect(ev.defaultPrevented).toBe(false)
    window.removeEventListener('markdown:replace', onReplace)
  })

  it('routes Ctrl+H by pane too: it stands down while the preview is the active pane (G4 pane-routing)', async () => {
    useUIStore.getState().setViewMode('split')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    // Split mode was the cell the original G4 fix left open: it only tested
    // `viewMode === 'preview'`, so with the preview as the active pane Ctrl+H still hijacked the key
    // to the editor's replace panel. Ctrl+F routes by pane via `findTargetPane`; Ctrl+H must use the
    // same predicate so both shortcuts agree on the target.
    fireEvent.pointerDown(screen.getByTestId('preview-pane'))
    let replaced = false
    const onReplace = () => {
      replaced = true
    }
    window.addEventListener('markdown:replace', onReplace)
    const ev = new KeyboardEvent('keydown', {
      key: 'h',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(ev)
    // The preview is the active pane and has no replace field: stand down without swallowing the key.
    expect(replaced).toBe(false)
    expect(ev.defaultPrevented).toBe(false)
    expect(document.querySelector('.cm-panel')).toBeNull()
    window.removeEventListener('markdown:replace', onReplace)

    // …and touching the editor pane hands the key straight back to it (both directions, mirroring
    // the Ctrl+F routing pair above).
    fireEvent.pointerDown(screen.getByTestId('editor-pane'))
    fireEvent.keyDown(window, { key: 'h', ctrlKey: true })
    await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
  })

  it('does not hijack Ctrl+F while a text <input> is focused (G5)', async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(ev)
    expect(document.querySelector('.cm-panel')).toBeNull()
    expect(ev.defaultPrevented).toBe(false)
    input.remove()
  })

  it('does not hijack Ctrl+F while a <textarea> is focused (G5)', async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(ev)
    expect(document.querySelector('.cm-panel')).toBeNull()
    ta.remove()
  })

  it('does not hijack Ctrl+F while a contentEditable element is focused (G5)', async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    // A rich-text (contentEditable) field that is NOT the editor itself — e.g. an inline editor in a
    // dialog. jsdom doesn't reflect `isContentEditable` from the attribute, so force it to exercise
    // the third arm of the editable-target guard (ADR-0023 / G5).
    const div = document.createElement('div')
    div.contentEditable = 'true'
    div.tabIndex = 0
    document.body.appendChild(div)
    Object.defineProperty(div, 'isContentEditable', { configurable: true, value: true })
    div.focus()
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(ev)
    expect(document.querySelector('.cm-panel')).toBeNull()
    div.remove()
  })

  it('still opens the editor find panel when Ctrl+F is pressed while the editor content holds focus (G5: editor surface is exempt)', async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    // The editor's own contentEditable (.cm-content) must NOT be treated as "someone else's field":
    // Ctrl/Cmd+F there belongs to the editor find widget. Force activeElement to it (jsdom doesn't
    // reflect isContentEditable from the attribute) to exercise the cm-content exempt arm.
    const content = document.querySelector('.cm-content') as HTMLElement
    Object.defineProperty(content, 'isContentEditable', { configurable: true, value: true })
    const original = Object.getOwnPropertyDescriptor(document, 'activeElement')
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => content })
    try {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
    } finally {
      if (original) Object.defineProperty(document, 'activeElement', original)
      else delete (document as unknown as { activeElement?: unknown }).activeElement
    }
  })

  it('still opens the replace panel when Ctrl+H is pressed while an input inside the find panel is focused (G5: cm-panel fields are exempt)', async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    // The find/replace widget's own fields live inside a CodeMirror panel, and their Ctrl/Cmd+F/H
    // belong to that widget (same rule as the .cm-content exemption). Without this arm the
    // re-open path was unreachable: focus sits in the find input the moment the panel opens, so
    // the guard swallowed every follow-up shortcut. Modelled with a standalone panel-like input
    // since exercising the real panel needs a full open cycle (pinned in e2e instead).
    const panel = document.createElement('div')
    panel.className = 'cm-panel'
    const input = document.createElement('input')
    panel.appendChild(input)
    document.body.appendChild(panel)
    input.focus()
    expect(document.activeElement).toBe(input)
    try {
      fireEvent.keyDown(window, { key: 'h', ctrlKey: true })
      await waitFor(() => expect(screen.getByTestId('editor-find')).toBeInTheDocument())
    } finally {
      panel.remove()
    }
  })

  it('still routes Ctrl+F when activeElement is null (G5 guard falsy branch)', async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    const original = Object.getOwnPropertyDescriptor(document, 'activeElement')
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      await waitFor(() => expect(document.querySelector('.cm-panel')).not.toBeNull())
    } finally {
      if (original) Object.defineProperty(document, 'activeElement', original)
      else delete (document as unknown as { activeElement?: unknown }).activeElement
    }
  })

  it('stands down from Ctrl+Shift+F (the Search view shortcut belongs to the app shell)', async () => {
    useUIStore.getState().setViewMode('edit')
    mount()
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    const seen: string[] = []
    const listener = (e: Event) => {
      seen.push(e.type)
    }
    document.addEventListener('markdown:find', listener)
    document.addEventListener('preview:find', listener)
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    })
    window.dispatchEvent(ev)
    document.removeEventListener('markdown:find', listener)
    document.removeEventListener('preview:find', listener)
    // Ctrl+Shift+F opens the Search view and is owned by the app shell (App.tsx). The editor must
    // not claim it — and must stand down WITHOUT preventDefault, so the shell's own handler still
    // receives the key (the same rule as every other shortcut that does not belong here).
    expect(seen).toEqual([])
    expect(ev.defaultPrevented).toBe(false)
  })
})

// PLAN C32 U5 / ADR-0024 §7.2: the title input is a focusable control, so it must show a
// visible focus indicator. It used to carry `focus:ring-0`, i.e. NO indicator at all — the one
// genuine WCAG 2.4.7 failure in the app.
describe('EditorPane focus indicators (C32 U5)', () => {
  it('gives the title input exactly one visible focus indicator', async () => {
    h.editingTitle = true
    mount()
    const input = await screen.findByTestId('title-input')
    expect(input.className).toContain('focus-ring')
    expect(input.className).not.toContain('focus:ring-0')
    expect(input.className).not.toContain('focus:ring-1')
    expect(input.className).not.toContain('focus:ring-2')
    expect(input.className).not.toContain('focus:border-accent')
  })
})
