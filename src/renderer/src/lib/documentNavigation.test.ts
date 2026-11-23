import { beforeEach, describe, expect, it, vi } from 'vitest'
import { moveNavigationHistory, moveToHistoryIndex, navigateToPath } from './documentNavigation'
import { useUIStore } from '../store/ui'
import { useNavigationHistory } from '../store/navigationHistory'
import { useTabsStore } from '../store/tabs'
import { __resetTabHistoriesForTests, getHistory, seedHistory } from '../store/tabHistory'
import '../i18n'

const doc = (id: string, filePath: string) => ({ id, filePath })

const api = {
  documents: {
    stat: vi.fn(async (_path: string) => ({ exists: true, size: 1, createdAt: 0, updatedAt: 0 })),
    get: vi.fn(async (id: string) => doc(id, 'C:/notes/a.md')),
    list: vi.fn(async (): Promise<Array<{ id: string; filePath: string }>> => []),
    import: vi.fn(async (path: string): Promise<{ id: string; filePath: string } | null> =>
      doc('imported', path),
    ),
    importMany: vi.fn(
      async (_paths: string[]): Promise<Array<{ id: string; filePath: string }>> => [],
    ),
    getWorkspaceRoot: vi.fn(async (): Promise<string | null> => 'C:/notes'),
    setWorkspaceRoot: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  },
  files: {
    resolvePaths: vi.fn(
      async (_paths: string[]): Promise<{ directories: string[]; markdownFiles: string[] }> => ({
        directories: [],
        markdownFiles: [],
      }),
    ),
  },
  dialog: { confirm: vi.fn(async (_opts: { message: string }) => true) },
}

const paths = () => useNavigationHistory.getState().entries.map((e) => e.path)

describe('documentNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = api
    useUIStore.setState({
      activeDocumentId: null,
      workspaceRoot: null,
      dirty: false,
      isNewUnsaved: false,
      printing: false,
    })
    useNavigationHistory.getState().reset()
    __resetTabHistoriesForTests()
    useTabsStore.getState().reset()
    api.documents.stat.mockResolvedValue({ exists: true, size: 1, createdAt: 0, updatedAt: 0 })
    api.documents.getWorkspaceRoot.mockResolvedValue('C:/notes')
    api.documents.import.mockImplementation(async (path) => doc('imported', path))
    api.documents.list.mockResolvedValue([])
  })

  it('activates an existing document in the current workspace and records it', async () => {
    api.documents.list.mockResolvedValue([doc('existing', 'C:/notes/a.md')])
    await expect(navigateToPath('C:/notes/a.md')).resolves.toBe(true)
    expect(useUIStore.getState().activeDocumentId).toBe('existing')
    expect(paths()).toEqual(['C:/notes/a.md'])
    expect(useNavigationHistory.getState().entries[0].openMode).toBe('in-place')
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('ADR-0041/0042: a rendered Markdown link reuses the current preview tab and records the navigation', async () => {
    const source = useTabsStore.getState().openTab('doc-source', {
      title: 'source.md',
      tabId: 'source',
      preview: true,
    })
    api.documents.get.mockImplementation(async (id: string) =>
      doc(id, id === 'doc-source' ? 'C:/notes/source.md' : 'C:/notes/a.md'),
    )
    api.documents.list.mockResolvedValue([doc('existing', 'C:/notes/a.md')])
    await expect(navigateToPath('C:/notes/a.md', { preview: true })).resolves.toBe(true)
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].documentId).toBe('existing')
    expect(state.previewTabId).toBe(source)
    expect(useUIStore.getState().activeDocumentId).toBe('existing')
    const history = useNavigationHistory.getState()
    expect(history.entryAt(history.cursor)).toMatchObject({
      path: 'C:/notes/a.md',
      tabId: source,
    })
  })

  it('ADR-0041: a link from a pinned source opens a new preview tab', async () => {
    useTabsStore.getState().openTab('doc-source', { title: 'source.md', tabId: 'source' })
    api.documents.list.mockResolvedValue([doc('existing', 'C:/notes/a.md')])
    await expect(navigateToPath('C:/notes/a.md', { preview: true })).resolves.toBe(true)
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.previewTabId).toBe(state.tabs[1].id)
    expect(state.activeTabId).toBe(state.previewTabId)
    expect(useUIStore.getState().activeDocumentId).toBe('existing')
  })

  it('ADR-0041: preview navigation activates an already-pinned target without moving the slot', async () => {
    const preview = useTabsStore.getState().openTab('doc-source', {
      title: 'source.md',
      tabId: 'source',
      preview: true,
    })
    const pinned = useTabsStore
      .getState()
      .openTab('doc-target', { title: 'target.md', tabId: 'target' })
    api.documents.list.mockResolvedValue([doc('doc-target', 'C:/notes/a.md')])
    await expect(navigateToPath('C:/notes/a.md', { preview: true })).resolves.toBe(true)
    expect(useTabsStore.getState().activeTabId).toBe(pinned)
    expect(useTabsStore.getState().previewTabId).toBe(preview)
  })

  it('refuses a file outside the workspace (routed elsewhere by the caller)', async () => {
    await expect(navigateToPath('D:/other/b.md')).resolves.toBe(false)
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
    expect(api.documents.import).not.toHaveBeenCalled()
  })

  it('imports an outside-root file as external for the external-keep choice', async () => {
    await expect(navigateToPath('D:/other/ext.md', { openMode: 'external-keep' })).resolves.toBe(
      true,
    )
    expect(api.documents.import).toHaveBeenCalledWith('D:/other/ext.md', { external: true })
    expect(useNavigationHistory.getState().entries[0].openMode).toBe('external-keep')
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('ADR-0040: navigation never prompts and never discards the outgoing draft', async () => {
    useUIStore.getState().reportUnsavedBuffer('old', 'unsaved text', 'a.md')
    useUIStore.setState({ dirty: true, activeDocumentTitle: 'a.md', activeDocumentId: 'old' })
    api.dialog.confirm.mockResolvedValueOnce(false)
    await expect(navigateToPath('C:/notes/b.md')).resolves.toBe(true)
    expect(api.dialog.confirm).not.toHaveBeenCalled()
    expect(useUIStore.getState().unsavedBuffers.old?.content).toBe('unsaved text')
  })

  it('ignores missing files', async () => {
    api.documents.stat.mockResolvedValueOnce({ exists: false, size: 0, createdAt: 0, updatedAt: 0 })
    await expect(navigateToPath('C:/notes/gone.md')).resolves.toBe(false)
    expect(paths()).toEqual([])
  })

  it('returns false when the document cannot be imported', async () => {
    api.documents.import.mockResolvedValueOnce(null)
    await expect(navigateToPath('C:/notes/a.md')).resolves.toBe(false)
    expect(paths()).toEqual([])
  })

  it('navigates within the active tab history when a tab is open (ADR-0040)', async () => {
    const tabId = useTabsStore.getState().openTab('doc-a', { title: 'a.md', tabId: 'tab-a' })
    seedHistory(tabId, [{ path: 'C:/notes/a.md' }, { path: 'C:/notes/b.md' }], 1)
    api.documents.list.mockResolvedValue([doc('existing', 'C:/notes/a.md')])
    await expect(moveNavigationHistory(-1)).resolves.toBe(true)
    // The tab's own stack moved the cursor; the legacy default store is not the source of truth.
    expect(getHistory(tabId)?.getState().cursor).toBe(0)
  })

  it('moves back without adding a new entry', async () => {
    const h = useNavigationHistory.getState()
    h.push('C:/notes/a.md')
    h.push('C:/notes/b.md')
    await expect(moveNavigationHistory(-1)).resolves.toBe(true)
    expect(useNavigationHistory.getState().cursor).toBe(0)
    expect(paths()).toEqual(['C:/notes/a.md', 'C:/notes/b.md'])
    expect(useUIStore.getState().activeDocumentId).toBe('imported')
  })

  it('refuses a Back move when the replay target cannot be imported', async () => {
    useNavigationHistory.getState().push('C:/notes/a.md')
    useNavigationHistory.getState().push('C:/notes/b.md')
    api.documents.list.mockResolvedValue([])
    api.documents.import.mockResolvedValueOnce(null)
    await expect(moveNavigationHistory(-1)).resolves.toBe(false)
    expect(useNavigationHistory.getState().cursor).toBe(1)
  })

  it('moves forward and prunes entries that no longer exist', async () => {
    const h = useNavigationHistory.getState()
    h.push('C:/notes/a.md')
    h.push('C:/notes/gone.md')
    h.push('C:/notes/c.md')
    useNavigationHistory.getState().setCursor(0)
    api.documents.stat.mockImplementation(async (path) => ({
      exists: path !== 'C:/notes/gone.md',
      size: 1,
      createdAt: 0,
      updatedAt: 0,
    }))
    await expect(moveNavigationHistory(1)).resolves.toBe(true)
    expect(paths()).toEqual(['C:/notes/a.md', 'C:/notes/c.md'])
    expect(useNavigationHistory.getState().cursor).toBe(1)
  })

  it('jumps to a history index without adding an entry', async () => {
    const h = useNavigationHistory.getState()
    h.push('C:/notes/a.md')
    h.push('C:/notes/b.md')
    h.push('C:/notes/c.md')
    await expect(moveToHistoryIndex(0)).resolves.toBe(true)
    expect(useNavigationHistory.getState().cursor).toBe(0)
    expect(paths()).toEqual(['C:/notes/a.md', 'C:/notes/b.md', 'C:/notes/c.md'])
  })

  it('refuses a direct index jump when the replay target cannot be imported', async () => {
    useNavigationHistory.getState().push('C:/notes/a.md')
    api.documents.list.mockResolvedValue([])
    api.documents.import.mockResolvedValueOnce(null)
    await expect(moveToHistoryIndex(0)).resolves.toBe(false)
    expect(useNavigationHistory.getState().cursor).toBe(0)
  })

  it('does nothing at the ends of history', async () => {
    await expect(moveNavigationHistory(-1)).resolves.toBe(false)
    useNavigationHistory.getState().push('C:/notes/a.md')
    await expect(moveNavigationHistory(1)).resolves.toBe(false)
  })

  it('refuses navigation while a file transaction is locked', async () => {
    useUIStore.setState({ printing: true })
    await expect(navigateToPath('C:/notes/a.md')).resolves.toBe(false)
    await expect(moveNavigationHistory(-1)).resolves.toBe(false)
    await expect(moveToHistoryIndex(0)).resolves.toBe(false)
  })

  it('uses the workspaceRoot mirror when present', async () => {
    useUIStore.setState({ workspaceRoot: 'C:/notes' })
    api.documents.getWorkspaceRoot.mockClear()
    await expect(navigateToPath('C:/notes/a.md')).resolves.toBe(true)
    expect(api.documents.getWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('history moves are not blocked by dirty background tabs', async () => {
    const h = useNavigationHistory.getState()
    h.push('C:/notes/a.md')
    h.push('C:/notes/b.md')
    useUIStore.setState({ dirty: true, activeDocumentTitle: 'b.md', activeDocumentId: 'old' })
    api.dialog.confirm.mockResolvedValueOnce(false)
    await expect(moveNavigationHistory(-1)).resolves.toBe(true)
    expect(api.dialog.confirm).not.toHaveBeenCalled()
    expect(useNavigationHistory.getState().cursor).toBe(0)
  })

  it('moveToHistoryIndex prunes a missing file and refuses the jump', async () => {
    const h = useNavigationHistory.getState()
    h.push('C:/notes/a.md')
    h.push('C:/notes/gone.md')
    api.documents.stat.mockImplementation(async (path) => ({
      exists: path !== 'C:/notes/gone.md',
      size: 1,
      createdAt: 0,
      updatedAt: 0,
    }))
    await expect(moveToHistoryIndex(1)).resolves.toBe(false)
    expect(paths()).toEqual(['C:/notes/a.md'])
  })

  it('moveToHistoryIndex refuses an out-of-range index', async () => {
    await expect(moveToHistoryIndex(0)).resolves.toBe(false)
  })

  it('moveToHistoryIndex applies a jump without a guard even when dirty', async () => {
    useNavigationHistory.getState().push('C:/notes/a.md')
    useUIStore.setState({ dirty: true, activeDocumentTitle: 'a.md', activeDocumentId: 'old' })
    api.dialog.confirm.mockResolvedValueOnce(false)
    await expect(moveToHistoryIndex(0)).resolves.toBe(true)
    expect(api.dialog.confirm).not.toHaveBeenCalled()
    expect(useNavigationHistory.getState().cursor).toBe(0)
  })

  it('exhausts the history loop when every target is gone', async () => {
    const h = useNavigationHistory.getState()
    h.push('C:/notes/a.md')
    h.push('C:/notes/b.md')
    api.documents.stat.mockResolvedValue({
      exists: false,
      size: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    await expect(moveNavigationHistory(-1)).resolves.toBe(false)
    // Back only visits the previous side; the current entry is never pruned by a move.
    expect(paths()).toEqual(['C:/notes/b.md'])
  })

  it('replays an external-switch entry by moving the workspace to the file folder', async () => {
    // An "external-switch" entry was created by switching the workspace, so replaying it must
    // switch back — navigating in place would refuse the file (it is outside the current root).
    useNavigationHistory.getState().push('D:/other/picked.md', { openMode: 'external-switch' })
    await expect(moveToHistoryIndex(0)).resolves.toBe(true)
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('D:/other')
    expect(api.documents.import).toHaveBeenCalledWith('D:/other/picked.md')
    // The replay moves the cursor; it never appends an entry.
    expect(paths()).toEqual(['D:/other/picked.md'])
  })

  it('ADR-0042: external-switch replay restores the entry replayRoot, not just the file folder', async () => {
    useNavigationHistory.getState().push('D:/other/sub/picked.md', {
      openMode: 'external-switch',
      replayRoot: 'D:/other',
    })
    await expect(moveToHistoryIndex(0)).resolves.toBe(true)
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('D:/other')
    // Older entries without replayRoot still fall back to dirName(entry.path).
    useNavigationHistory.getState().reset()
    useNavigationHistory.getState().push('D:/legacy/picked.md', { openMode: 'external-switch' })
    await expect(moveToHistoryIndex(0)).resolves.toBe(true)
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('D:/legacy')
  })

  it('ADR-0042: replay from an unpinned tab reuses it even if the entry has no tabId', async () => {
    api.documents.list.mockResolvedValue([
      doc('current-doc', 'C:/notes/current.md'),
      doc('source-doc', 'C:/notes/source.md'),
    ])
    const tab = useTabsStore.getState().openTab('current-doc', { tabId: 'preview', preview: true })
    seedHistory(
      'preview',
      [{ path: 'C:/notes/source.md' }, { path: 'C:/notes/current.md', tabId: 'preview' }],
      1,
    )
    await expect(moveNavigationHistory(-1)).resolves.toBe(true)
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].id).toBe(tab)
    expect(state.tabs[0].documentId).toBe('source-doc')
    expect(state.activeTabId).toBe(tab)
  })

  it('ADR-0042: replay reuses the tab recorded in the history entry', async () => {
    api.documents.list.mockResolvedValue([
      doc('source-doc', 'C:/notes/source.md'),
      doc('target-doc', 'C:/notes/target.md'),
    ])
    const tab = useTabsStore.getState().openTab('target-doc', { tabId: 'home' })
    seedHistory('home', [{ path: 'C:/notes/source.md', tabId: 'home' }], 0)
    await expect(moveToHistoryIndex(0)).resolves.toBe(true)
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].id).toBe(tab)
    expect(state.tabs[0].documentId).toBe('source-doc')
    expect(state.activeTabId).toBe(tab)
  })

  it('ADR-0042: replaying an entry restores its editor position via pendingMatch', async () => {
    api.documents.list.mockResolvedValue([doc('existing', 'C:/notes/a.md')])
    seedHistory(
      'tab-a',
      [{ path: 'C:/notes/a.md', tabId: 'tab-a', position: { start: 3, end: 7 } }],
      0,
    )
    useTabsStore.getState().openTab('existing', { tabId: 'tab-a' })
    await expect(moveToHistoryIndex(0)).resolves.toBe(true)
    expect(useUIStore.getState().pendingMatch).toEqual({ id: 'existing', start: 3, end: 7 })
  })

  it('replays an external-keep entry in place, without switching the workspace', async () => {
    useNavigationHistory.getState().push('D:/other/kept.md', { openMode: 'external-keep' })
    await expect(moveToHistoryIndex(0)).resolves.toBe(true)
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
    expect(api.documents.import).toHaveBeenCalledWith('D:/other/kept.md', { external: true })
  })
})
