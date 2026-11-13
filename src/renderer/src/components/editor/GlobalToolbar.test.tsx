import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import '../../i18n'
import { GlobalToolbar } from './GlobalToolbar'
import { TooltipProvider } from '../ui/tooltip'
import { useUIStore } from '../../store/ui'
import { formatShortcut } from '../../lib/utils'

const h = vi.hoisted(() => {
  const createDraft = vi.fn(async () => {})
  // The "at most one draft" predicate the button's disabled state is derived from.
  const hasDraft = vi.fn(() => false)
  return { createDraft, hasDraft }
})
vi.mock('../../hooks/useDocuments', () => ({
  createDraft: () => h.createDraft(),
  useHasMemoryOnlyDraft: () => h.hasDraft(),
}))

// The global toolbar was extracted from `EditorPane` into its own component (ADR-0030). This suite
// locks the contract that extraction must preserve: the same actions, the same wiring, and the
// same store-driven visibility — plus the fact that the sidebar toggle BUTTON is gone from it
// (the sidebar is still reachable from the ActivityBar right-click menu, the native View menu and
// the Ctrl/Cmd+\ handlers).
describe('GlobalToolbar', () => {
  const onSave = vi.fn()
  const onSaveAs = vi.fn()
  const onReload = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => {
    h.createDraft.mockClear()
    h.hasDraft.mockClear()
    onSave.mockClear()
    onSaveAs.mockClear()
    onReload.mockClear()
    onClose.mockClear()
    useUIStore.setState({
      activeDocumentId: null,
      editable: true,
      dirty: false,
      viewMode: 'split',
      searchOpen: false,
      exportOpen: false,
      fileDetailsId: null,
    })
  })

  afterEach(cleanup)

  function mount(props: Partial<React.ComponentProps<typeof GlobalToolbar>> = {}) {
    return render(
      <TooltipProvider>
        <GlobalToolbar
          onSave={onSave}
          onSaveAs={onSaveAs}
          onReload={onReload}
          onClose={onClose}
          savePending={false}
          saveAsPending={false}
          reloadPending={false}
          {...props}
        />
      </TooltipProvider>,
    )
  }

  it('renders the quick-open trigger and the close button when a document is open', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1' })
    mount()
    expect(screen.getByTestId('editor-goto-file-btn')).toBeInTheDocument()
    expect(screen.getByTestId('close-btn')).toBeInTheDocument()
  })

  // The single direct-create entry point. It is unconditional: an in-memory draft needs no
  // folder, unlike the sidebar's filesystem-bound "New File" button.
  it('always renders the New Draft button, even with no document or folder open', () => {
    useUIStore.setState({ activeDocumentId: null, activeFolder: null })
    mount()
    expect(screen.getByTestId('new-document-btn')).toBeInTheDocument()
    expect(screen.getByTestId('new-document-btn')).not.toBeDisabled()
  })

  // At most one unsaved draft: the button is disabled while a memory-only draft already exists,
  // so the user cannot start a second one from the toolbar.
  it('disables the New Draft button while an unsaved draft already exists', () => {
    h.hasDraft.mockReturnValueOnce(true)
    mount()
    expect(screen.getByTestId('new-document-btn')).toBeDisabled()
  })

  // R5 plan A (user report 2026-11-13): the store refuses every document transaction while the
  // system print dialog is up, so each of these buttons must LOOK disabled — and come back when
  // printing ends. The native menu already mirrors the flag; the toolbar did not.
  it('disables every file command while printing and restores them afterwards', () => {
    useUIStore.setState({
      activeDocumentId: 'doc-1',
      editable: true,
      dirty: true,
      viewMode: 'edit',
    })
    mount()
    const ids = [
      'editor-goto-file-btn',
      'new-document-btn',
      'save-btn',
      'save-as-btn',
      'reload-btn',
      'file-details-btn',
      'export-btn',
      'close-btn',
    ]
    try {
      act(() => useUIStore.getState().setPrinting(true))
      for (const id of ids) expect(screen.getByTestId(id), id).toBeDisabled()
    } finally {
      act(() => useUIStore.getState().setPrinting(false))
    }
    for (const id of ids) expect(screen.getByTestId(id), id).not.toBeDisabled()
  })

  // The capability is fileLocked, NOT the printing trigger alone: exporting must lock the same
  // controls without any of them subscribing to `exporting`. This is the regression the fileLocked
  // capability exists to prevent — adding a trigger source changes one selector, not seven components.
  it('disables every file command while exporting (capability, not the printing trigger)', () => {
    useUIStore.setState({
      activeDocumentId: 'doc-1',
      editable: true,
      dirty: true,
      viewMode: 'edit',
    })
    mount()
    const ids = [
      'editor-goto-file-btn',
      'new-document-btn',
      'save-btn',
      'save-as-btn',
      'reload-btn',
      'file-details-btn',
      'export-btn',
      'close-btn',
    ]
    try {
      act(() => useUIStore.getState().setExporting(true))
      for (const id of ids) expect(screen.getByTestId(id), id).toBeDisabled()
    } finally {
      act(() => useUIStore.getState().setExporting(false))
    }
    for (const id of ids) expect(screen.getByTestId(id), id).not.toBeDisabled()
  })

  it('creates a memory-only draft and opens no dialog from the New Draft button', () => {
    mount()
    fireEvent.click(screen.getByTestId('new-document-btn'))
    expect(h.createDraft).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().newDocOpen).toBe(false)
  })

  it('gives Quick Open the jump glyph and New Draft the former document glyph', () => {
    mount()
    const goto = screen.getByTestId('editor-goto-file-btn').querySelector('svg')!.outerHTML
    const draft = screen.getByTestId('new-document-btn').querySelector('svg')!.outerHTML
    // Not a magnifier (adjacent find button wears one), and not the same glyph as New Draft —
    // the original complaint was that "Go to file" looked like "create a file".
    expect(goto).not.toBe(draft)
  })

  // The sidebar toggle button was removed from the global bar (ADR-0030 / Q2a). Its absence is
  // asserted rather than assumed: a regression that re-adds it would silently duplicate a control
  // the ActivityBar right-click menu already owns.
  it('no longer renders a sidebar toggle button', () => {
    mount()
    expect(screen.queryByTestId('sidebar-toggle-btn')).toBeNull()
  })

  it('opens the search view from the quick-open trigger', () => {
    mount()
    fireEvent.click(screen.getByTestId('editor-goto-file-btn'))
    expect(useUIStore.getState().searchOpen).toBe(true)
  })

  it('hides the file operations while no document is open', () => {
    mount()
    expect(screen.queryByTestId('save-btn')).toBeNull()
    expect(screen.queryByTestId('save-as-btn')).toBeNull()
    expect(screen.queryByTestId('reload-btn')).toBeNull()
    expect(screen.queryByTestId('file-details-btn')).toBeNull()
    expect(screen.queryByTestId('close-btn')).toBeNull()
  })

  it('wires save, save-as, reload and close to the handlers it was given', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1', editable: true, dirty: true })
    mount()
    fireEvent.click(screen.getByTestId('save-btn'))
    expect(onSave).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('save-as-btn'))
    expect(onSaveAs).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('reload-btn'))
    expect(onReload).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('close-btn'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disables save while the document is read-only', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1', editable: false, dirty: true })
    mount()
    expect(screen.getByTestId('save-btn')).toBeDisabled()
  })

  it('disables save while the document has no unsaved changes', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1', editable: true, dirty: false })
    mount()
    expect(screen.getByTestId('save-btn')).toBeDisabled()
  })

  it('disables save while a save is in flight', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1', editable: true, dirty: true })
    mount({ savePending: true })
    expect(screen.getByTestId('save-btn')).toBeDisabled()
  })

  // A "save as" is a different operation from "save", so it has its own pending flag — but it also
  // blocks the plain save, because the two would race for the same document.
  it('disables save and save-as while a save-as is in flight', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1', editable: true, dirty: true })
    mount({ saveAsPending: true })
    expect(screen.getByTestId('save-btn')).toBeDisabled()
    expect(screen.getByTestId('save-as-btn')).toBeDisabled()
  })

  it('disables reload while a reload is in flight', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1' })
    mount({ reloadPending: true })
    expect(screen.getByTestId('reload-btn')).toBeDisabled()
  })

  it('opens the file details dialog for the active document', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1' })
    mount()
    fireEvent.click(screen.getByTestId('file-details-btn'))
    expect(useUIStore.getState().fileDetailsId).toBe('doc-1')
  })

  // Export follows the preview's visibility (ADR-0024 §10 trade-off 46): exactly one export button
  // is on screen at a time, so it lives here only in edit-only mode.
  it('shows the export button only in edit-only mode', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1', viewMode: 'split' })
    mount()
    expect(screen.queryByTestId('export-btn')).toBeNull()
    act(() => {
      useUIStore.setState({ viewMode: 'edit' })
    })
    expect(screen.getByTestId('export-btn')).toBeInTheDocument()
  })

  it('opens the export dialog from the export button', () => {
    useUIStore.setState({ activeDocumentId: 'doc-1', viewMode: 'edit' })
    mount()
    fireEvent.click(screen.getByTestId('export-btn'))
    expect(useUIStore.getState().exportOpen).toBe(true)
  })

  // ADR-0032 moved Quick Open to ⌘⇧K and File Details to ⌘⇧I. The VISIBLE glyph must follow the
  // real binding — a stale glyph advertises a shortcut that does something else, which is worse
  // than no glyph at all.
  it('advertises ⌘⇧K on the quick-open trigger', async () => {
    mount()
    screen.getByTestId('editor-goto-file-btn').focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(formatShortcut('⌘⇧K'))
  })

  it('advertises ⌘⇧I on the file-details button', async () => {
    useUIStore.setState({ activeDocumentId: 'doc-1' })
    mount()
    screen.getByTestId('file-details-btn').focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(formatShortcut('⌘⇧I'))
  })
})
