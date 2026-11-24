import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useUIStore } from './ui'
import { useTabsStore } from './tabs'
import { useNavigationHistory } from './navigationHistory'
// Initialises the i18next singleton so the store's guard prompts are translated rather than
// returning raw keys.
import '../i18n'

describe('useUIStore — all setters and toggles', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // reset to defaults between tests via a fresh state snapshot is overkill; just set known values
    useTabsStore.getState().reset()
    const s = useUIStore.getState()
    s.setSidebarOpen(true)
    s.setActiveDocumentId(null)
    s.setWorkspaceRoot(null)
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

  it('setActiveDocumentId is a pure mirror: no navigation recording (ADR-0040 T14)', async () => {
    const { useNavigationHistory } = await import('./navigationHistory')
    useNavigationHistory.getState().reset()
    const get = vi.fn(async () => ({ id: 'doc-1', filePath: 'C:/n/a.md' }))
    ;(window as unknown as { api: unknown }).api = { documents: { get } }
    useUIStore.getState().setActiveDocumentId('doc-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useUIStore.getState().activeDocumentId).toBe('doc-1')
    expect(get).not.toHaveBeenCalled()
    expect(useNavigationHistory.getState().entries).toEqual([])
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

    useUIStore.getState().setWorkspaceRoot('/f')
    expect(useUIStore.getState().workspaceRoot).toBe('/f')

    useUIStore.getState().setViewMode('preview')
    expect(useUIStore.getState().viewMode).toBe('preview')

    // View-mode cycle (Cmd/Ctrl+Shift+P): advances through the shared order and wraps.
    useUIStore.getState().setViewMode('split')
    useUIStore.getState().cycleViewMode()
    expect(useUIStore.getState().viewMode).toBe('preview')
    useUIStore.getState().cycleViewMode()
    expect(useUIStore.getState().viewMode).toBe('edit')
    useUIStore.getState().cycleViewMode()
    expect(useUIStore.getState().viewMode).toBe('split')

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

    // ADR-0040: `saving` joins the file lock, so clear it (and printing) before exercising
    // the export-dialog setter.
    useUIStore.getState().setPrinting(false)
    useUIStore.getState().setSaving(false)
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

  it('closeWorkspace clears the global navigation history', () => {
    useNavigationHistory.getState().push('C:/old/a.md', { tabId: 'a' })
    useNavigationHistory.getState().push('C:/old/b.md', { tabId: 'a' })
    useNavigationHistory.getState().push('C:/old/c.md', { tabId: 'a' })
    useUIStore.getState().closeWorkspace()
    const history = useNavigationHistory.getState()
    expect(history.entries).toEqual([])
    expect(history.cursor).toBe(-1)
  })

  it('closeWorkspace clears the active document and folder', () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setWorkspaceRoot('/f')
    useUIStore.getState().closeWorkspace()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().workspaceRoot).toBeNull()
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

  // R5 plan A: with the standalone print PREVIEW window gone, the main window stays interactive
  // so its preview pane can be scrolled. The old mainWindow.setEnabled(false) whole-window lock is
  // therefore replaced by a store-level transaction lock: no editing, no switching/closing files,
  // no opening the export dialog — or the print job could be built from a different document.
  it('printing locks document switches/closes and the export dialog, and releases them afterwards', async () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('doc-a')
    s.setWorkspaceRoot('/workspace')
    s.setDirty(false)
    s.setPrinting(true)

    expect(await s.selectDocument('doc-b'), 'switching files must be refused').toBe(false)
    expect(useUIStore.getState().activeDocumentId).toBe('doc-a')
    expect(await s.openDocumentAt('doc-b', 0, 10), 'opening another file must be refused').toBe(
      false,
    )
    expect(useUIStore.getState().activeDocumentId).toBe('doc-a')

    useUIStore.getState().closeDocument()
    expect(useUIStore.getState().activeDocumentId).toBe('doc-a')
    useUIStore.getState().closeWorkspace()
    expect(useUIStore.getState().workspaceRoot).toBe('/workspace')
    useUIStore.getState().setExportOpen(true)
    expect(useUIStore.getState().exportOpen, 'the export dialog must not open').toBe(false)

    // The edit/read-only toggle is a document mutation too: flipping it while printing would let
    // the document silently become editable the moment the system dialog closes.
    const editableBefore = useUIStore.getState().editable
    useUIStore.getState().toggleEditable()
    expect(useUIStore.getState().editable, 'the edit-mode toggle must be refused').toBe(
      editableBefore,
    )

    // No permanent state corruption: the lock is gone as soon as printing ends.
    s.setPrinting(false)
    useUIStore.getState().toggleEditable()
    expect(useUIStore.getState().editable, 'the toggle works again').toBe(!editableBefore)
    expect(await useUIStore.getState().selectDocument('doc-b')).toBe(true)
    expect(useUIStore.getState().activeDocumentId).toBe('doc-b')
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
    useUIStore.getState().setWorkspaceRoot('/watched')

    useUIStore.getState().closeWorkspace()

    // The root is CLEARED, not just unwatched: leaving it set would keep scope and replace
    // reasoning about a workspace that is supposed to be closed (ADR-0023).
    expect(setWorkspaceRoot).toHaveBeenCalledWith(null)
    expect(useUIStore.getState().workspaceRoot).toBeNull()
  })

  it('closeWorkspace still closes when the root teardown rejects', async () => {
    const setWorkspaceRoot = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(
      window as unknown as { api: { documents: { setWorkspaceRoot: typeof setWorkspaceRoot } } }
    ).api = { documents: { setWorkspaceRoot } }
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setWorkspaceRoot('/watched')

    useUIStore.getState().closeWorkspace()
    await Promise.resolve()

    // The workspace must still be cleared: teardown is best-effort, never a gate.
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().workspaceRoot).toBeNull()
  })

  it('closeWorkspace still closes when the preload bridge is unavailable', () => {
    ;(window as unknown as { api?: unknown }).api = undefined
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setWorkspaceRoot('/watched')

    expect(() => useUIStore.getState().closeWorkspace()).not.toThrow()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().workspaceRoot).toBeNull()
  })
})

// ADR-0023: the unsaved-switch guard lives in the STORE so that every entry point is covered by
// construction, instead of each call site remembering to wrap itself.
describe('useUIStore — guarded document switching (ADR-0023)', () => {
  let confirm: ReturnType<typeof vi.fn>

  beforeEach(() => {
    confirm = vi.fn(async () => true)
    ;(window as unknown as { api: unknown }).api = { dialog: { confirm } }
    useTabsStore.getState().reset()
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

  it('ADR-0040: switching tabs NEVER prompts and NEVER discards the outgoing draft', async () => {
    useUIStore.getState().setDirty(true)
    useUIStore.getState().reportUnsavedBuffer('a', 'unsaved text', 'Alpha*.md')
    const ok = await useUIStore.getState().selectDocument('b')
    expect(ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(useUIStore.getState().unsavedBuffers.a).toEqual({
      content: 'unsaved text',
      title: 'Alpha*.md',
      revision: 1,
    })
    expect(useTabsStore.getState().activeTabId).toBeTruthy()
  })

  it('openDocumentAt jumps into the target tab without a guard', async () => {
    useUIStore.getState().setDirty(true)
    const ok = await useUIStore.getState().openDocumentAt('b', 10, 13)
    expect(ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(useUIStore.getState().pendingMatch).toEqual({ id: 'b', start: 10, end: 13 })
  })

  it('openDocumentAt reuses the preview tab and records the hit range in global history', async () => {
    useNavigationHistory.getState().reset()
    const get = vi.fn(async () => ({
      id: 'hit-target',
      filePath: 'C:/notes/hit-target.md',
      title: 'Hit.md',
    }))
    ;(window as unknown as { api: unknown }).api = { documents: { get } }
    const source = useTabsStore.getState().openTab('hit-source', {
      tabId: 'hit-source',
      preview: true,
    })
    await expect(
      useUIStore.getState().openDocumentAt('hit-target', 4, 8, { preview: true }),
    ).resolves.toBe(true)
    const tabs = useTabsStore.getState()
    expect(tabs.previewTabId).toBe(source)
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].documentId).toBe('hit-target')
    await waitFor(() => {
      const history = useNavigationHistory.getState()
      expect(history.entryAt(history.cursor)).toMatchObject({
        path: 'C:/notes/hit-target.md',
        tabId: source,
        position: { start: 4, end: 8 },
      })
    })
  })

  it('selectDocument preview reuse falls back to an empty title when the document has none', async () => {
    ;(window as unknown as { api: unknown }).api = {
      documents: { get: vi.fn(async () => ({ id: 'no-title', filePath: 'C:/notes/no-title.md' })) },
    }
    const source = useTabsStore.getState().openTab('no-title-source', {
      tabId: 'no-title-source',
      preview: true,
    })
    await expect(useUIStore.getState().selectDocument('no-title', { preview: true })).resolves.toBe(
      true,
    )
    expect(useTabsStore.getState().previewTabId).toBe(source)
    expect(useTabsStore.getState().tabs[0].title).toBe('')
  })

  it('openDocumentAt records no history entry for a memory-only document', async () => {
    useNavigationHistory.getState().reset()
    ;(window as unknown as { api: unknown }).api = {
      documents: { get: vi.fn(async () => ({ id: 'mem-hit', filePath: '' })) },
    }
    await expect(
      useUIStore.getState().openDocumentAt('mem-hit', 1, 2, { preview: true }),
    ).resolves.toBe(true)
    await waitFor(() => expect(useNavigationHistory.getState().entries).toHaveLength(0))
  })

  it('selectDocument names a newly opened tab from the document title', async () => {
    const get = vi.fn(async () => ({ id: 'b', filePath: 'C:/notes/B.md', title: 'B.md' }))
    ;(window as unknown as { api: unknown }).api = { documents: { get } }
    await expect(useUIStore.getState().selectDocument('b')).resolves.toBe(true)
    await waitFor(() => {
      const tab = useTabsStore.getState().tabs.find((item) => item.documentId === 'b')
      expect(tab?.title).toBe('B.md')
    })
    expect(useUIStore.getState().activeDocumentTitle).toBe('B.md')
  })

  it('selectDocument activates a tab that appeared while the document lookup was pending', async () => {
    let resolveDoc!: (value: unknown) => void
    const get = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDoc = resolve
        }),
    )
    ;(window as unknown as { api: unknown }).api = { documents: { get } }
    const pending = useUIStore.getState().selectDocument('race')
    const racedId = useTabsStore.getState().openTab('race', { title: 'Race.md' })
    resolveDoc({ id: 'race', filePath: 'C:/notes/Race.md', title: 'Race.md' })
    await expect(pending).resolves.toBe(true)
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useTabsStore.getState().tabs[0].id).toBe(racedId)
    expect(useTabsStore.getState().activeTabId).toBe(racedId)
  })

  it('selectDocument pins an existing preview on an explicit pinned open', async () => {
    const id = useTabsStore.getState().openTab('b', { tabId: 'b', preview: true })
    await expect(useUIStore.getState().selectDocument('b', { preview: false })).resolves.toBe(true)
    expect(useTabsStore.getState().previewTabId).toBeNull()
    expect(useTabsStore.getState().activeTabId).toBe(id)
  })

  it('selectDocument preview reuses the current preview tab without pinning its source', async () => {
    const get = vi.fn(async () => ({
      id: 'target',
      filePath: 'C:/notes/target.md',
      title: 'target.md',
    }))
    ;(window as unknown as { api: unknown }).api = { documents: { get } }
    const source = useTabsStore.getState().openTab('source', { tabId: 'source', preview: true })
    await expect(useUIStore.getState().selectDocument('target', { preview: true })).resolves.toBe(
      true,
    )
    const tabs = useTabsStore.getState()
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].documentId).toBe('target')
    expect(tabs.previewTabId).toBe(source)
    expect(tabs.tabs[0].id).toBe(source)
    expect(tabs.activeTabId).toBe(tabs.previewTabId)
  })

  it('selectDocument preview activates an already-pinned target without moving the slot', async () => {
    const source = useTabsStore.getState().openTab('source', { tabId: 'source', preview: true })
    const target = useTabsStore.getState().openTab('target', { tabId: 'target', activate: false })
    await expect(useUIStore.getState().selectDocument('target', { preview: true })).resolves.toBe(
      true,
    )
    expect(useTabsStore.getState().activeTabId).toBe(target)
    expect(useTabsStore.getState().previewTabId).toBe(source)
  })

  it('selectDocument pins a tab that raced in during a pinned lookup', async () => {
    let resolveDoc!: (value: unknown) => void
    const get = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDoc = resolve
        }),
    )
    ;(window as unknown as { api: unknown }).api = { documents: { get } }
    const pending = useUIStore.getState().selectDocument('race', { preview: false })
    const racedId = useTabsStore.getState().openTab('race', { tabId: 'race', preview: true })
    resolveDoc({ id: 'race', filePath: 'C:/notes/Race.md', title: 'Race.md' })
    await expect(pending).resolves.toBe(true)
    expect(useTabsStore.getState().previewTabId).toBeNull()
    expect(useTabsStore.getState().activeTabId).toBe(racedId)
  })

  it('selectDocument works even without a dialog bridge (no guard needed)', async () => {
    ;(window as unknown as { api?: unknown }).api = undefined
    useUIStore.getState().setDirty(true)
    const ok = await useUIStore.getState().selectDocument('b')
    expect(ok).toBe(true)
    expect(useTabsStore.getState().activeTabId).toBeTruthy()
  })

  it('selectDocument seeds no history when the documents bridge lacks get()', async () => {
    ;(window as unknown as { api: unknown }).api = { documents: {} }
    await expect(useUIStore.getState().selectDocument('missing-get')).resolves.toBe(true)
    expect(useTabsStore.getState().activeTabId).toBeTruthy()
  })

  it('selectDocument seeds no history for a memory-only draft', async () => {
    const get = vi.fn(async () => ({ id: 'draft', filePath: '', title: 'draft', memoryOnly: true }))
    ;(window as unknown as { api: unknown }).api = { documents: { get } }
    const tabs = useTabsStore.getState()
    const before = tabs.tabs.length
    await expect(useUIStore.getState().selectDocument('draft')).resolves.toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useTabsStore.getState().tabs.length).toBe(before + 1)
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

  it('openDocumentAt keeps the previous tab draft while jumping', async () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('a')
    s.setActiveDocumentTitle(null)
    s.setDirty(true)
    s.reportUnsavedBuffer('a', 'x')
    const ok = await useUIStore.getState().openDocumentAt('b', 5, 9)
    expect(ok).toBe(true)
    expect(useUIStore.getState().pendingMatch).toEqual({ id: 'b', start: 5, end: 9 })
    expect(useUIStore.getState().unsavedBuffers.a).toBeDefined()
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

// Switching edit -> read-only is a "discard" decision too: the user leaves the editing surface.
// It must use the same two-state guard as a document switch, and a confirmed discard must REALLY
// throw the draft away and reload the on-disk bytes (not silently keep the stale editor text).
describe('useUIStore — guarded edit/read-only toggle', () => {
  let confirm: ReturnType<typeof vi.fn>

  beforeEach(() => {
    confirm = vi.fn(async () => true)
    const deleteDoc = vi.fn(async () => true)
    ;(window as unknown as { api: unknown }).api = {
      dialog: { confirm },
      documents: { delete: deleteDoc },
    }
    const s = useUIStore.getState()
    s.setLanguage('en')
    s.setActiveDocumentId('a')
    s.setActiveDocumentTitle('Alpha')
    s.setEditable(true)
    s.setDirty(false)
    s.setIsNewUnsaved(false)
    s.setPrinting(false)
    s.setExporting(false)
    s.setExportOpen(false)
    s.requestFileAction(null)
    for (const id of Object.keys(s.unsavedBuffers)) s.clearUnsavedBuffer(id)
  })

  it('toggles freely without prompting when nothing is dirty', async () => {
    await useUIStore.getState().toggleEditable()
    expect(useUIStore.getState().editable).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(useUIStore.getState().pendingFileAction).toBeNull()
  })

  it('keeps edit mode and the draft when the user chooses Keep editing', async () => {
    confirm.mockResolvedValueOnce(false)
    useUIStore.getState().setDirty(true)
    useUIStore.getState().reportUnsavedBuffer('a', 'unsaved text')
    const ok = await useUIStore.getState().toggleEditable()
    expect(confirm).toHaveBeenCalledTimes(1)
    // The prompt must describe the mode switch, not say "switch files".
    expect(confirm.mock.calls[0][0].message).toContain('read-only')
    expect(ok).toBe(false)
    expect(useUIStore.getState().editable).toBe(true)
    expect(useUIStore.getState().dirty).toBe(true)
    expect(useUIStore.getState().unsavedBuffers.a?.content).toBe('unsaved text')
    expect(useUIStore.getState().pendingFileAction).toBeNull()
  })

  it('discards the draft and requests a disk reload when the user confirms', async () => {
    useUIStore.getState().setDirty(true)
    useUIStore.getState().reportUnsavedBuffer('a', 'unsaved text')
    const ok = await useUIStore.getState().toggleEditable()
    expect(ok).toBe(true)
    expect(useUIStore.getState().editable).toBe(false)
    expect(useUIStore.getState().dirty).toBe(false)
    expect(useUIStore.getState().unsavedBuffers.a).toBeUndefined()
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'reload' })
  })

  it('guards a dirty document with no title and no id on the discard path', async () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId(null)
    s.setActiveDocumentTitle(null)
    // setActiveDocumentId resets edit mode, so re-enter it to exercise the edit -> read-only guard.
    s.setEditable(true)
    s.setDirty(true)
    const ok = await useUIStore.getState().toggleEditable()
    expect(ok).toBe(true)
    expect(confirm.mock.calls[0][0].message).toContain('read-only')
    expect(useUIStore.getState().editable).toBe(false)
    expect(useUIStore.getState().dirty).toBe(false)
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'reload' })
  })

  it('never discards silently when no dialog bridge is available', async () => {
    ;(window as unknown as { api?: unknown }).api = undefined
    useUIStore.getState().setDirty(true)
    useUIStore.getState().reportUnsavedBuffer('a', 'unsaved text')
    const ok = await useUIStore.getState().toggleEditable()
    expect(ok).toBe(false)
    expect(useUIStore.getState().editable).toBe(true)
    expect(useUIStore.getState().dirty).toBe(true)
    expect(useUIStore.getState().unsavedBuffers.a).toBeDefined()
  })

  it('does not prompt when switching from read-only back to edit', async () => {
    useUIStore.getState().setEditable(false)
    useUIStore.getState().setDirty(true)
    const ok = await useUIStore.getState().toggleEditable()
    expect(ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(useUIStore.getState().editable).toBe(true)
    // Still dirty: entering edit mode must not throw the draft away.
    expect(useUIStore.getState().dirty).toBe(true)
  })

  it('closes a memory-only draft on discard instead of requesting a reload', async () => {
    useUIStore.getState().setIsNewUnsaved(true)
    useUIStore.getState().setDirty(true)
    const ok = await useUIStore.getState().toggleEditable()
    expect(ok).toBe(true)
    expect(window.api.documents.delete).toHaveBeenCalledWith('a')
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().editable).toBe(false)
    expect(useUIStore.getState().dirty).toBe(false)
    expect(useUIStore.getState().isNewUnsaved).toBe(false)
    expect(useUIStore.getState().pendingFileAction).toBeNull()
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
    expect(useUIStore.getState().unsavedBuffers.a).toEqual({
      content: 'two',
      title: '',
      revision: 2,
    })
  })

  it('closeTabDocument deletes a memory-only draft and honours the explicit flag', () => {
    const deleteDoc = vi.fn(async () => true)
    ;(window as unknown as { api: unknown }).api = {
      documents: { delete: deleteDoc, setWorkspaceRoot: vi.fn() },
    }
    useUIStore.getState().reportUnsavedBuffer('draft-x', 'body')
    useUIStore.getState().closeTabDocument('draft-x', true)
    expect(deleteDoc).toHaveBeenCalledWith('draft-x')
    expect(useUIStore.getState().unsavedBuffers['draft-x']).toBeUndefined()
  })

  it('isTabDirty ignores empty ids and closeTabDocument preserves a background dirty flag', () => {
    expect(useUIStore.getState().isTabDirty('')).toBe(false)
    useUIStore.getState().setActiveDocumentId('active')
    useUIStore.getState().reportUnsavedBuffer('background', 'draft')
    useUIStore.getState().setDirty(true)
    useUIStore.getState().closeTabDocument('background')
    expect(useUIStore.getState().unsavedBuffers.background).toBeUndefined()
    expect(useUIStore.getState().dirty).toBe(true)
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

// Field-scoped subscriptions are a performance contract, not a style choice: ADR-0033 writes the
// registry on every keystroke, so an identity-selector subscriber re-renders the whole app once
// per character. This is the behavioural counterpart to e2e/guards/ui-store-selectors.test.ts.
describe('useUIStore — selector-scoped subscriptions', () => {
  it('does not re-render a subscriber that reads only theme on a registry write', () => {
    let renders = 0
    const { unmount } = renderHook(() => {
      renders += 1
      return useUIStore((s) => s.theme)
    })
    const before = renders
    act(() => {
      for (let i = 0; i < 24; i += 1) {
        useUIStore.getState().reportUnsavedBuffer('selector-probe', `keystroke ${i}`)
      }
    })
    // 24 writes produce 24 new state objects, but the selected slice never changed.
    expect(renders).toBe(before)
    expect(useUIStore.getState().unsavedBuffers['selector-probe'].content).toBe('keystroke 23')
    act(() => useUIStore.getState().clearUnsavedBuffer('selector-probe'))
    unmount()
  })

  it('keeps action references stable across registry writes', () => {
    // Components read actions through getState() instead of subscribing (Vercel
    // rerender-defer-reads). That is only safe while the initializer never reassigns them.
    const before = useUIStore.getState().setNewDocOpen
    act(() => {
      for (let i = 0; i < 24; i += 1) {
        useUIStore.getState().reportUnsavedBuffer('action-probe', `keystroke ${i}`)
      }
    })
    expect(useUIStore.getState().setNewDocOpen).toBe(before)
    act(() => useUIStore.getState().clearUnsavedBuffer('action-probe'))
  })
})

// The theme entry (ADR-0028): a three-way choice — light / dark / follow the system — defaulting
// to the system preference, resolved live against the OS.
describe('useUIStore theme', () => {
  afterEach(() => {
    useUIStore.getState().setTheme('system')
  })

  it('starts on the system preference', () => {
    // `getInitialState` is the pristine store state, so an earlier test that changed the theme
    // cannot mask the default this assertion is about.
    expect(useUIStore.getInitialState().theme).toBe('system')
  })

  it('stores an explicit light or dark choice', () => {
    useUIStore.getState().setTheme('dark')
    expect(useUIStore.getState().theme).toBe('dark')
    useUIStore.getState().setTheme('light')
    expect(useUIStore.getState().theme).toBe('light')
    useUIStore.getState().setTheme('system')
    expect(useUIStore.getState().theme).toBe('system')
  })

  // The choice is deliberately NOT persisted: each launch starts from the default. The store has no
  // persist middleware, so there is nothing that could restore a previous choice.
  it('does not persist the theme choice', () => {
    expect((useUIStore as unknown as { persist?: unknown }).persist).toBeUndefined()
  })
})
