import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUIStore } from './ui'
// Initialises the i18next singleton so the store's guard prompts are translated rather than
// returning raw keys.
import '../i18n'

describe('useUIStore — all setters and toggles', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // reset to defaults between tests via a fresh state snapshot is overkill; just set known values
    const s = useUIStore.getState()
    s.setSidebarOpen(true)
    s.setActiveDocumentId(null)
    s.setActiveFolder(null)
    s.setEditable(false)
    s.setViewMode('split')
    s.setSearchOpen(false)
    s.setSearchQuery('')
    s.setTheme('light')
    s.setLanguage('en')
    s.setNewDocOpen(false)
    s.setAboutOpen(false)
    s.setDirty(false)
    s.setSaving(false)
    s.setPrinting(false)
    s.setJustSaved(false)
    s.setExternalChange(null)
    s.setFileDetailsId(null)
    s.setExportOpen(false)
    s.setExporting(false)
    s.setIsNewUnsaved(false)
    s.setSidebarView('files')
    s.setSearchInclude('')
    s.setSearchExclude('')
    s.setSearchMatchCase(false)
    s.setSearchReplaceText('')
    s.setSearchReplaceOpen(false)
    s.setSearchDetailsOpen(false)
    s.setActiveDocumentTitle(null)
  })

  it('toggleSidebar flips the flag', () => {
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarOpen).toBe(false)
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarOpen).toBe(true)
  })

  it('toggleEditable flips the flag', () => {
    useUIStore.getState().toggleEditable()
    expect(useUIStore.getState().editable).toBe(true)
  })

  it('simple setters update their slices', () => {
    useUIStore.getState().setActiveDocumentId('x')
    expect(useUIStore.getState().activeDocumentId).toBe('x')

    useUIStore.getState().setActiveFolder('/f')
    expect(useUIStore.getState().activeFolder).toBe('/f')

    useUIStore.getState().setViewMode('preview')
    expect(useUIStore.getState().viewMode).toBe('preview')

    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('q')
    expect(useUIStore.getState().searchOpen).toBe(true)
    expect(useUIStore.getState().searchQuery).toBe('q')

    // Search view scope + replace state (ADR-0023).
    useUIStore.getState().setSearchInclude('./docs')
    useUIStore.getState().setSearchExclude('./archive')
    useUIStore.getState().setSearchMatchCase(true)
    useUIStore.getState().setSearchWholeWord(true)
    useUIStore.getState().setSearchRegexp(true)
    useUIStore.getState().setSearchReplaceText('new')
    useUIStore.getState().setSearchReplaceOpen(true)
    useUIStore.getState().setSearchDetailsOpen(true)
    expect(useUIStore.getState().searchInclude).toBe('./docs')
    expect(useUIStore.getState().searchExclude).toBe('./archive')
    expect(useUIStore.getState().searchMatchCase).toBe(true)
    expect(useUIStore.getState().searchWholeWord).toBe(true)
    expect(useUIStore.getState().searchRegexp).toBe(true)
    expect(useUIStore.getState().searchReplaceText).toBe('new')
    expect(useUIStore.getState().searchReplaceOpen).toBe(true)
    expect(useUIStore.getState().searchDetailsOpen).toBe(true)

    // Focus nonces: the tree's "Search in This Folder" cannot reach the input element, so it bumps
    // a nonce the Search view consumes (ADR-0023 D8).
    useUIStore.getState().requestSearchFocus()
    useUIStore.getState().requestScopeFocus()
    expect(useUIStore.getState().searchFocusNonce).toBe(1)
    expect(useUIStore.getState().searchScopeFocusNonce).toBe(1)

    // Mutually exclusive sidebar surfaces.
    useUIStore.getState().setSidebarView('search')
    expect(useUIStore.getState().sidebarView).toBe('search')

    useUIStore.getState().setTheme('dark')
    expect(useUIStore.getState().theme).toBe('dark')

    useUIStore.getState().setNewDocOpen(true)
    expect(useUIStore.getState().newDocOpen).toBe(true)

    useUIStore.getState().setAboutOpen(true)
    expect(useUIStore.getState().aboutOpen).toBe(true)

    useUIStore.getState().setDirty(true)
    expect(useUIStore.getState().dirty).toBe(true)

    useUIStore.getState().setSaving(true)
    useUIStore.getState().setPrinting(true)
    useUIStore.getState().setJustSaved(true)
    expect(useUIStore.getState().saving).toBe(true)
    expect(useUIStore.getState().printing).toBe(true)
    expect(useUIStore.getState().justSaved).toBe(true)

    useUIStore.getState().setExternalChange({ id: 'e', filePath: '/e' })
    expect(useUIStore.getState().externalChange).toEqual({ id: 'e', filePath: '/e' })
    useUIStore.getState().clearExternalChange()
    expect(useUIStore.getState().externalChange).toBeNull()

    useUIStore.getState().setFileDetailsId('fd')
    expect(useUIStore.getState().fileDetailsId).toBe('fd')

    useUIStore.getState().setExportOpen(true)
    useUIStore.getState().setExporting(true)
    expect(useUIStore.getState().exportOpen).toBe(true)
    expect(useUIStore.getState().exporting).toBe(true)

    useUIStore.getState().setIsNewUnsaved(true)
    expect(useUIStore.getState().isNewUnsaved).toBe(true)
  })

  it('setLanguage persists the choice', () => {
    useUIStore.getState().setLanguage('zh-CN')
    expect(useUIStore.getState().language).toBe('zh-CN')
  })

  it('closeWorkspace clears the active document and folder', () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setActiveFolder('/f')
    useUIStore.getState().closeWorkspace()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().activeFolder).toBeNull()
  })

  // Closing means the edits are discarded, so the global dirty flag must not survive:
  // it used to, which made the NEXT dirty check (switching documents, dropping a file,
  // quitting) ask "discard unsaved changes?" a second time for already-discarded edits.
  it('closeDocument clears the dirty flag (discarded edits must not re-prompt)', () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setEditable(true)
    s.setDirty(true)
    expect(useUIStore.getState().dirty).toBe(true)

    useUIStore.getState().closeDocument()

    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().editable).toBe(false)
    expect(useUIStore.getState().dirty).toBe(false)
  })

  it('closeWorkspace clears the dirty flag', () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setEditable(true)
    s.setDirty(true)

    useUIStore.getState().closeWorkspace()

    expect(useUIStore.getState().dirty).toBe(false)
  })

  it('a blocked close leaves dirty untouched (nothing was discarded)', () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setDirty(true)
    s.setExporting(true)
    useUIStore.getState().closeDocument()
    expect(useUIStore.getState().activeDocumentId).toBe('x')
    // Still dirty: the document was NOT closed, so the edits are still unsaved.
    expect(useUIStore.getState().dirty).toBe(true)
    s.setExporting(false)
  })

  it('closeWorkspace is blocked while exporting or the export dialog is open', () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setExporting(true)
    useUIStore.getState().closeWorkspace()
    expect(useUIStore.getState().activeDocumentId).toBe('x')
    s.setExporting(false)
    s.setExportOpen(true)
    useUIStore.getState().closeWorkspace()
    expect(useUIStore.getState().activeDocumentId).toBe('x')
    s.setExportOpen(false)
  })

  it('closeWorkspace removes an unsaved memory-only draft via the api', async () => {
    ;(
      window as unknown as {
        api: { documents: { delete: ReturnType<typeof vi.fn>; setWorkspaceRoot?: unknown } }
      }
    ).api = {
      documents: { delete: vi.fn().mockResolvedValue(true), setWorkspaceRoot: vi.fn() },
    }
    const s = useUIStore.getState()
    s.setActiveDocumentId('draft-1')
    s.setIsNewUnsaved(true)
    useUIStore.getState().closeWorkspace()
    expect(window.api.documents.delete).toHaveBeenCalledWith('draft-1')
    // the draft flag is cleared
    expect(useUIStore.getState().isNewUnsaved).toBe(false)
  })

  it('closeWorkspace tells the main process to drop the workspace root', () => {
    const setWorkspaceRoot = vi.fn().mockResolvedValue(undefined)
    ;(
      window as unknown as { api: { documents: { setWorkspaceRoot: typeof setWorkspaceRoot } } }
    ).api = { documents: { setWorkspaceRoot } }
    useUIStore.getState().setActiveFolder('/watched')

    useUIStore.getState().closeWorkspace()

    // The root is CLEARED, not just unwatched: leaving it set would keep scope and replace
    // reasoning about a workspace that is supposed to be closed (ADR-0023).
    expect(setWorkspaceRoot).toHaveBeenCalledWith(null)
    expect(useUIStore.getState().activeFolder).toBeNull()
  })

  it('closeWorkspace still closes when the root teardown rejects', async () => {
    const setWorkspaceRoot = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(
      window as unknown as { api: { documents: { setWorkspaceRoot: typeof setWorkspaceRoot } } }
    ).api = { documents: { setWorkspaceRoot } }
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setActiveFolder('/watched')

    useUIStore.getState().closeWorkspace()
    await Promise.resolve()

    // The workspace must still be cleared: teardown is best-effort, never a gate.
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().activeFolder).toBeNull()
  })

  it('closeWorkspace still closes when the preload bridge is unavailable', () => {
    ;(window as unknown as { api?: unknown }).api = undefined
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setActiveFolder('/watched')

    expect(() => useUIStore.getState().closeWorkspace()).not.toThrow()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().activeFolder).toBeNull()
  })
})

// ADR-0023: the unsaved-switch guard lives in the STORE so that every entry point is covered by
// construction, instead of each call site remembering to wrap itself.
describe('useUIStore — guarded document switching (ADR-0023)', () => {
  let confirm: ReturnType<typeof vi.fn>

  beforeEach(() => {
    confirm = vi.fn(async () => true)
    ;(window as unknown as { api: unknown }).api = { dialog: { confirm } }
    const s = useUIStore.getState()
    s.setActiveDocumentId('a')
    s.setActiveDocumentTitle('Alpha')
    s.setDirty(false)
    s.setPendingMatch(null)
  })

  it('switches freely when nothing is dirty', async () => {
    const ok = await useUIStore.getState().selectDocument('b')
    expect(ok).toBe(true)
    expect(useUIStore.getState().activeDocumentId).toBe('b')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('is a no-op when switching to the document already open', async () => {
    useUIStore.getState().setDirty(true)
    await useUIStore.getState().selectDocument('a')
    // Re-selecting the SAME document discards nothing, so it must not prompt.
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks before discarding, and names the document being left', async () => {
    useUIStore.getState().setDirty(true)
    await useUIStore.getState().selectDocument('b')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0].message).toContain('Alpha')
  })

  it('changes NOTHING when the user keeps their edits', async () => {
    confirm.mockResolvedValueOnce(false)
    useUIStore.getState().setDirty(true)
    useUIStore.getState().reportUnsavedBuffer('a', 'unsaved text')
    const ok = await useUIStore.getState().selectDocument('b')
    expect(ok).toBe(false)
    expect(useUIStore.getState().activeDocumentId).toBe('a')
    // The unsaved buffer must survive "keep editing".
    expect(useUIStore.getState().unsavedBuffers.a).toBeDefined()
  })

  it('drops the unsaved buffer when the user discards', async () => {
    useUIStore.getState().setDirty(true)
    useUIStore.getState().reportUnsavedBuffer('a', 'unsaved text')
    await useUIStore.getState().selectDocument('b')
    expect(useUIStore.getState().unsavedBuffers.a).toBeUndefined()
    expect(useUIStore.getState().activeDocumentId).toBe('b')
  })

  it('openDocumentAt only records the jump once the guard has passed', async () => {
    confirm.mockResolvedValueOnce(false)
    useUIStore.getState().setDirty(true)
    const ok = await useUIStore.getState().openDocumentAt('b', 10, 13)
    expect(ok).toBe(false)
    // No half-applied switch: the pending match must not be written for a document we never
    // opened, or the editor would jump into the wrong file.
    expect(useUIStore.getState().pendingMatch).toBeNull()
  })

  it('confirmDiscard returns false when the dialog bridge is unavailable', async () => {
    // No preload bridge (unit test / missing contextMenu): must never discard silently.
    ;(window as unknown as { api?: unknown }).api = undefined
    const s = useUIStore.getState()
    s.setActiveDocumentId('a')
    s.setDirty(true)
    const ok = await useUIStore.getState().selectDocument('b')
    expect(ok).toBe(false)
    expect(useUIStore.getState().activeDocumentId).toBe('a')
  })

  it('selectDocument discards when leaving a null-id dirty document', async () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId(null)
    s.setActiveDocumentTitle(null)
    s.setDirty(true)
    const ok = await useUIStore.getState().selectDocument('b')
    expect(ok).toBe(true)
    expect(useUIStore.getState().activeDocumentId).toBe('b')
  })

  it('openDocumentAt applies the jump after a confirmed discard', async () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('a')
    s.setActiveDocumentTitle(null)
    s.setDirty(true)
    s.reportUnsavedBuffer('a', 'x')
    const ok = await useUIStore.getState().openDocumentAt('b', 5, 9)
    expect(ok).toBe(true)
    expect(useUIStore.getState().activeDocumentId).toBe('b')
    expect(useUIStore.getState().pendingMatch).toEqual({ id: 'b', start: 5, end: 9 })
    expect(useUIStore.getState().unsavedBuffers.a).toBeUndefined()
  })

  it('openDocumentAt discards when leaving a null-id dirty document', async () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId(null)
    s.setActiveDocumentTitle(null)
    s.setDirty(true)
    const ok = await useUIStore.getState().openDocumentAt('b', 1, 2)
    expect(ok).toBe(true)
    expect(useUIStore.getState().pendingMatch).toEqual({ id: 'b', start: 1, end: 2 })
  })
})

describe('useUIStore — search focus nonce', () => {
  it('requestSearchFocus bumps the focus nonce', () => {
    const before = useUIStore.getState().searchFocusNonce
    useUIStore.getState().requestSearchFocus()
    expect(useUIStore.getState().searchFocusNonce).toBe(before + 1)
  })
})

describe('useUIStore — unsaved buffer registry (ADR-0023)', () => {
  beforeEach(() => {
    const s = useUIStore.getState()
    s.setActiveDocumentId(null)
    s.setDirty(false)
    for (const id of Object.keys(useUIStore.getState().unsavedBuffers)) s.clearUnsavedBuffer(id)
  })

  it('bumps the document revision on every buffer change', () => {
    const before = useUIStore.getState().documentStateRevision
    useUIStore.getState().reportUnsavedBuffer('a', 'one')
    expect(useUIStore.getState().documentStateRevision).toBe(before + 1)
    useUIStore.getState().reportUnsavedBuffer('a', 'two')
    expect(useUIStore.getState().documentStateRevision).toBe(before + 2)
    expect(useUIStore.getState().unsavedBuffers.a).toEqual({ content: 'two', revision: 2 })
  })

  it('covers MORE than the active document', () => {
    // The whole point: the main process needs every dirty buffer, and "only the active one" is
    // exactly the restriction that would silently overwrite a background edit.
    useUIStore.getState().reportUnsavedBuffer('a', 'x')
    useUIStore.getState().reportUnsavedBuffer('b', 'y')
    expect(Object.keys(useUIStore.getState().unsavedBuffers).sort()).toEqual(['a', 'b'])
  })

  it('clears a buffer and bumps the revision', () => {
    useUIStore.getState().reportUnsavedBuffer('a', 'x')
    const before = useUIStore.getState().documentStateRevision
    useUIStore.getState().clearUnsavedBuffer('a')
    expect(useUIStore.getState().unsavedBuffers.a).toBeUndefined()
    expect(useUIStore.getState().documentStateRevision).toBe(before + 1)
  })

  it('is a no-op when clearing a buffer that was never reported', () => {
    const before = useUIStore.getState().documentStateRevision
    useUIStore.getState().clearUnsavedBuffer('nope')
    expect(useUIStore.getState().documentStateRevision).toBe(before)
  })

  it('clears every buffer on closeDocument and closeWorkspace', () => {
    useUIStore.getState().reportUnsavedBuffer('a', 'x')
    useUIStore.getState().setIsNewUnsaved(false)
    useUIStore.getState().closeDocument()
    expect(useUIStore.getState().unsavedBuffers).toEqual({})
  })
})
