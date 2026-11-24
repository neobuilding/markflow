import { beforeEach, describe, expect, it, vi } from 'vitest'
import { switchWorkspace } from './workspaceSwitch'
import { useUIStore } from '../store/ui'
import { useNavigationHistory } from '../store/navigationHistory'
import { useTabsStore } from '../store/tabs'
import { getHistory, seedHistory } from '../store/tabHistory'
import '../i18n'

// The workspace switch is a TRANSACTION owned by one service: lock check → conditional unsaved
// guard → store/watcher swap → keep or close the active document → exactly one history entry.
// Every case below asserts the resulting STATE (active document, dirty flag, history) rather
// than "which method was called", so the test pins behaviour, not choreography.

// The document shape the store works with. `import` can legitimately resolve to null (the file
// vanished between picking it and importing it), so the mock's return type says so explicitly —
// otherwise TypeScript infers a non-nullable return and rejects the "import failed" cases.
type Doc = { id: string; filePath: string; title: string; memoryOnly: boolean }

const doc = (id: string, filePath: string, title = 'a'): Doc => ({
  id,
  filePath,
  title,
  memoryOnly: false,
})

const api = {
  documents: {
    get: vi.fn(async (id: string): Promise<Doc | null> => doc(id, 'C:/notes/sub/a.md')),
    setWorkspaceRoot: vi.fn(async (_root: string | null) => undefined),
    import: vi.fn(async (path: string): Promise<Doc | null> =>
      doc('imported', path, path.split('/').pop() ?? 'a'),
    ),
    importMany: vi.fn(async (_paths: string[]): Promise<Doc[]> => []),
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

const history = () => useNavigationHistory.getState().entries
const paths = () => history().map((e) => e.path)

function captureFocusRequests(): { calls: () => number; stop: () => void } {
  const listener = vi.fn()
  document.addEventListener('editor:focus-request', listener)
  return {
    calls: () => listener.mock.calls.length,
    stop: () => document.removeEventListener('editor:focus-request', listener),
  }
}

describe('switchWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = api
    useUIStore.setState({
      activeDocumentId: null,
      activeDocumentTitle: null,
      workspaceRoot: null,
      dirty: false,
      isNewUnsaved: false,
      printing: false,
      exporting: false,
      exportOpen: false,
      unsavedBuffers: {},
    })
    useNavigationHistory.getState().reset()
    useTabsStore.getState().reset()
    // mockReset (not just clearAllMocks) so a queued one-shot value from a previous case cannot
    // leak into this one.
    api.documents.get.mockReset()
    api.documents.get.mockImplementation(async (id: string) => doc(id, 'C:/notes/sub/a.md'))
    api.documents.import.mockReset()
    api.documents.import.mockImplementation(async (path: string) =>
      doc('imported', path, path.split('/').pop() ?? 'a'),
    )
    api.documents.importMany.mockReset()
    api.documents.importMany.mockImplementation(async () => [])
    api.files.resolvePaths.mockReset()
    api.files.resolvePaths.mockImplementation(async () => ({ directories: [], markdownFiles: [] }))
    api.dialog.confirm.mockReset()
    api.dialog.confirm.mockResolvedValue(true)
  })

  it('refuses to switch while a file transaction is locked', async () => {
    useUIStore.setState({ printing: true })
    await expect(switchWorkspace('C:/other')).resolves.toBe(false)
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('keeps the current document when it lives inside the new root', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    await expect(switchWorkspace('C:/notes')).resolves.toBe(true)
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('C:/notes')
    expect(api.documents.import).toHaveBeenCalledWith('C:/notes/sub/a.md')
    expect(useUIStore.getState().activeDocumentId).toBe('imported')
    expect(paths()).toEqual(['C:/notes/sub/a.md'])
    expect(history()[0].openMode).toBe('in-place')
  })

  it('closes the document and opens nothing when it is outside the new root', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    await expect(switchWorkspace('D:/other')).resolves.toBe(true)
    expect(api.documents.import).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(paths()).toEqual([])
  })

  it('imports every Markdown file under the new root so the sidebar can list them', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['D:/other'],
      markdownFiles: ['D:/other/alpha.md', 'D:/other/beta.md'],
    })

    await expect(switchWorkspace('D:/other')).resolves.toBe(true)

    // The swap clears the store and the watcher uses ignoreInitial: without this batch import the
    // new root stays empty, so the sidebar lists no files — and no folders either, because
    // document-less branches are hidden by default (ADR-0010).
    expect(api.files.resolvePaths).toHaveBeenCalledWith(['D:/other'])
    expect(api.documents.importMany).toHaveBeenCalledWith(['D:/other/alpha.md', 'D:/other/beta.md'])
  })

  it('does not import the opened target twice while back-filling the new root', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['D:/other'],
      markdownFiles: ['D:/other/alpha.md', 'D:/other/picked.md'],
    })

    await expect(
      switchWorkspace('D:/other', { openMode: 'external-switch', openPath: 'D:/other/picked.md' }),
    ).resolves.toBe(true)

    expect(api.documents.importMany).toHaveBeenCalledWith(['D:/other/alpha.md'])
    expect(api.documents.import).toHaveBeenCalledWith('D:/other/picked.md')
  })

  it('does not import the kept document twice while back-filling the new root', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['C:/notes'],
      markdownFiles: ['C:/notes/sub/a.md', 'C:/notes/sub/b.md'],
    })

    await expect(switchWorkspace('C:/notes')).resolves.toBe(true)

    // The kept file is re-imported separately below to migrate its id and buffer, so the batch
    // import must skip it — otherwise one path would end up as two document rows.
    expect(api.documents.importMany).toHaveBeenCalledWith(['C:/notes/sub/b.md'])
    expect(api.documents.import).toHaveBeenCalledTimes(1)
    expect(api.documents.import).toHaveBeenCalledWith('C:/notes/sub/a.md')
    expect(useUIStore.getState().activeDocumentId).toBe('imported')
  })

  it('ignores files outside the new root while back-filling the sidebar', async () => {
    // resolvePaths is a defensive boundary: it must not be able to pull an unrelated file into
    // the fresh workspace just because it appeared in the batch.
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['C:/notes'],
      markdownFiles: ['C:/notes/sub/a.md', 'D:/stray/outside.md'],
    })

    await expect(switchWorkspace('C:/notes')).resolves.toBe(true)

    expect(api.documents.importMany).toHaveBeenCalledWith(['C:/notes/sub/a.md'])
  })

  it('excludes the target even when disk and link paths use different separators', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    // files:resolve-paths returns node:path.join() results (backslashes on Windows) while the
    // four-way dialog hands us a forward-slashed link path. Both name the same file.
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: ['D:\\other'],
      markdownFiles: ['D:\\other\\alpha.md', 'D:\\other\\picked.md'],
    })

    await expect(switchWorkspace('D:/other', { openPath: 'D:/other/picked.md' })).resolves.toBe(
      true,
    )

    expect(api.documents.importMany).toHaveBeenCalledWith(['D:\\other\\alpha.md'])
    expect(api.documents.import).toHaveBeenCalledWith('D:/other/picked.md')
  })

  it('migrates the unsaved buffer to the re-imported document', async () => {
    useUIStore.setState({
      activeDocumentId: 'a',
      workspaceRoot: 'C:/notes/sub',
      dirty: true,
      unsavedBuffers: { a: { content: 'edited', revision: 1 } },
    })
    await expect(switchWorkspace('C:/notes')).resolves.toBe(true)
    expect(useUIStore.getState().unsavedBuffers.imported?.content).toBe('edited')
    expect(useUIStore.getState().dirty).toBe(true)
  })

  it('replay mode reuses a tab, prunes out-of-root history and migrates the title draft', async () => {
    useTabsStore.getState().reset()
    const tabId = useTabsStore.getState().openTab('a', { title: 'a.md', tabId: 'keep-tab' })
    seedHistory(tabId, [{ path: 'C:/notes/sub/a.md' }, { path: 'D:/outside/b.md' }], 1)
    useUIStore.setState({
      activeDocumentId: 'a',
      workspaceRoot: 'C:/notes/sub',
      dirty: true,
      unsavedBuffers: { a: { content: 'edited', title: 'a*.md', revision: 1 } },
    })
    await expect(
      switchWorkspace('C:/notes', { replayTabId: tabId, openPath: 'C:/notes/picked.md' }),
    ).resolves.toBe(true)
    // The replay tab's document was replaced, not duplicated.
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useTabsStore.getState().tabs[0].documentId).toBe('imported')
  })

  it('replay without openPath reuses the initiating tab for the kept document', async () => {
    useTabsStore.getState().reset()
    const tabId = useTabsStore.getState().openTab('a', { title: 'a.md', tabId: 'keep-tab' })
    useUIStore.setState({
      activeDocumentId: 'a',
      workspaceRoot: 'C:/notes/sub',
      dirty: false,
      unsavedBuffers: {},
    })
    await expect(switchWorkspace('C:/notes', { replayTabId: tabId })).resolves.toBe(true)
    expect(useTabsStore.getState().tabs).toHaveLength(1)
  })

  it('keeps an edit made while the document lookup is in flight', async () => {
    // reportUnsavedBuffer replaces the whole `unsavedBuffers` object, so a snapshot taken
    // before the first await would migrate the pre-keystroke content and lose the last edit.
    useUIStore.setState({
      activeDocumentId: 'a',
      workspaceRoot: 'C:/notes/sub',
      dirty: true,
      unsavedBuffers: { a: { content: 'before', revision: 1 } },
    })
    let resolveGet: ((value: Doc) => void) | undefined
    api.documents.get.mockReturnValueOnce(
      new Promise<Doc>((resolve) => {
        resolveGet = resolve
      }),
    )
    const switching = switchWorkspace('C:/notes')
    useUIStore.getState().reportUnsavedBuffer('a', 'after')
    resolveGet!(doc('a', 'C:/notes/sub/a.md'))
    await expect(switching).resolves.toBe(true)

    expect(useUIStore.getState().unsavedBuffers.imported?.content).toBe('after')
  })

  it('does not prompt when the document is kept (nothing is lost)', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub', dirty: true })
    await expect(switchWorkspace('C:/notes')).resolves.toBe(true)
    expect(api.dialog.confirm).not.toHaveBeenCalled()
  })

  it('prompts with the FILE guard and restores editor focus on Keep editing', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub', dirty: true })
    api.dialog.confirm.mockResolvedValueOnce(false)
    const focus = captureFocusRequests()
    try {
      await expect(switchWorkspace('D:/other')).resolves.toBe(false)
    } finally {
      focus.stop()
    }
    // ADR-0038 §3.2 decision 6 / ADR-0039 §3.2: one file guard, no second workspace prompt.
    const message = api.dialog.confirm.mock.calls[0][0].message
    expect(message).toContain('switch files?')
    expect(message).not.toContain('new workspace')
    expect(focus.calls()).toBe(1) // ADR-0023 decision 9: "keep editing" returns focus to the editor
    expect(api.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeDocumentId).toBe('a')
  })

  it('closes the document before replacing the workspace', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    let activeIdAtSwap: string | null = 'not-yet-called'
    api.documents.setWorkspaceRoot.mockImplementationOnce(async () => {
      activeIdAtSwap = useUIStore.getState().activeDocumentId
    })
    await expect(switchWorkspace('D:/other')).resolves.toBe(true)
    expect(activeIdAtSwap).toBeNull() // ADR-0038 §3.2 decision 6: close document first
  })

  it('clears the dirty flag when the discarded document is closed', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub', dirty: true })
    api.dialog.confirm.mockResolvedValueOnce(true)
    await expect(switchWorkspace('D:/other')).resolves.toBe(true)
    // The edits were discarded with the document, so the next guard must not ask again.
    expect(useUIStore.getState().dirty).toBe(false)
  })

  it('opens the requested file when the caller names one (the switch-workspace exit)', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    await expect(
      switchWorkspace('D:/other', { openMode: 'external-switch', openPath: 'D:/other/picked.md' }),
    ).resolves.toBe(true)
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('D:/other')
    expect(api.documents.import).toHaveBeenCalledWith('D:/other/picked.md')
    expect(useUIStore.getState().activeDocumentId).toBe('imported')
    // The history records the file the user picked, with the mode that replays it.
    expect(paths()).toEqual(['D:/other/picked.md'])
    expect(history()[0].openMode).toBe('external-switch')
    expect(history()[0].replayRoot).toBe('D:/other')
  })

  it('defaults the tab-path replayRoot to the new root for an external switch', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes' })
    useTabsStore.getState().openTab('a', { tabId: 'a', title: 'a' })
    await expect(
      switchWorkspace('D:/other', { openMode: 'external-switch', openPath: 'D:/other/picked.md' }),
    ).resolves.toBe(true)
    expect(history()[0]).toMatchObject({ openMode: 'external-switch', replayRoot: 'D:/other' })
  })

  it('records an explicit replayRoot when the caller supplies one', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes' })
    await expect(
      switchWorkspace('D:/other', {
        openMode: 'external-switch',
        openPath: 'D:/other/picked.md',
        replayRoot: 'D:/custom',
      }),
    ).resolves.toBe(true)
    expect(history()[0].replayRoot).toBe('D:/custom')
  })

  it('closes the previous document when a target file is named', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub', dirty: true })
    api.dialog.confirm.mockResolvedValueOnce(true)
    await expect(
      switchWorkspace('D:/other', { openMode: 'external-switch', openPath: 'D:/other/picked.md' }),
    ).resolves.toBe(true)
    // The current document IS being closed, so the unsaved guard must have run and the dirty
    // flag must not survive the swap.
    expect(api.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().dirty).toBe(false)
  })

  it('closes everything when the requested file cannot be imported', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    api.documents.import.mockResolvedValueOnce(null)
    await expect(
      switchWorkspace('D:/other', { openMode: 'external-switch', openPath: 'D:/other/picked.md' }),
    ).resolves.toBe(true)
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(paths()).toEqual([])
  })

  it('closes everything when the kept document cannot be re-imported', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    api.documents.import.mockResolvedValueOnce(null)
    await expect(switchWorkspace('C:/notes')).resolves.toBe(true)
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(paths()).toEqual([])
  })

  it('records no history entry while replaying an existing one', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes/sub' })
    await expect(
      switchWorkspace('D:/other', {
        openMode: 'external-switch',
        openPath: 'D:/other/picked.md',
        record: false,
      }),
    ).resolves.toBe(true)
    expect(paths()).toEqual([])
    expect(useUIStore.getState().activeDocumentId).toBe('imported')
  })

  it('ignores a memory-only draft as the document to keep', async () => {
    // A draft has no file on disk, so it can never survive a workspace swap.
    api.documents.get.mockResolvedValueOnce({
      id: 'draft',
      filePath: '',
      title: 'draft',
      memoryOnly: true,
    })
    useUIStore.setState({ activeDocumentId: 'draft', workspaceRoot: 'C:/notes/sub' })
    await expect(switchWorkspace('C:/notes')).resolves.toBe(true)
    expect(api.documents.import).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })

  it('switches with no active document at all', async () => {
    await expect(switchWorkspace('D:/other')).resolves.toBe(true)
    expect(api.documents.setWorkspaceRoot).toHaveBeenCalledWith('D:/other')
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })

  it('ADR-0040: migrates every kept tab, closes out-of-root tabs after ONE aggregate prompt', async () => {
    api.documents.get.mockImplementation(async (id: string) =>
      doc(id, id === 'c' ? 'D:/outside/c.md' : `C:/notes/${id}.md`, id),
    )
    api.documents.import.mockImplementation(async (path: string) => ({
      id: `new-${path}`,
      filePath: path,
      title: path,
      memoryOnly: false,
    }))
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: [],
      markdownFiles: ['C:/notes/a.md', 'C:/notes/b.md', 'C:/notes/other.md'],
    })
    const tabs = useTabsStore.getState()
    const a = tabs.openTab('a', { tabId: 'a', title: 'a' })
    tabs.openTab('b', { tabId: 'b', title: 'b', activate: false })
    tabs.openTab('c', { tabId: 'c', title: 'c', activate: false })
    useUIStore.getState().reportUnsavedBuffer('a', 'draft-a', 'A edited')
    useUIStore.getState().reportUnsavedBuffer('c', 'draft-c', 'C edited')
    seedHistory(a, [{ path: 'C:/notes/a.md' }, { path: 'D:/outside/old.md' }], 1)

    await expect(switchWorkspace('C:/notes', { record: false })).resolves.toBe(true)

    expect(api.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().unsavedBuffers['new-C:/notes/a.md']?.content).toBe('draft-a')
    expect(useUIStore.getState().unsavedBuffers['new-C:/notes/a.md']?.title).toBe('A edited')
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual(['a', 'b'])
    expect(useTabsStore.getState().tabs[0].documentId).toBe('new-C:/notes/a.md')
    expect(useTabsStore.getState().tabs[0].title).toBe('C:/notes/a.md')
    // The out-of-root in-place entry was pruned from the surviving tab's stack.
    expect(
      getHistory('a')
        ?.getState()
        .entries.map((e: { path: string }) => e.path),
    ).toEqual(['C:/notes/a.md'])
    expect(api.documents.importMany).toHaveBeenCalledWith(['C:/notes/other.md'])
  })

  it('records an ordinary root switch as in-place without a replayRoot', async () => {
    useUIStore.setState({ activeDocumentId: 'a', workspaceRoot: 'C:/notes' })
    useTabsStore.getState().openTab('a', { tabId: 'a', title: 'a' })
    await expect(
      switchWorkspace('C:/notes/sub', { openPath: 'C:/notes/sub/picked.md' }),
    ).resolves.toBe(true)
    expect(history()[0]).toMatchObject({ openMode: 'in-place', path: 'C:/notes/sub/picked.md' })
    expect(history()[0].replayRoot).toBeUndefined()
  })

  it('ADR-0040: vetoing the aggregate prompt leaves every tab and draft intact', async () => {
    api.documents.get.mockImplementation(async (id: string) => doc(id, `C:/notes/${id}.md`, id))
    api.dialog.confirm.mockResolvedValueOnce(false)
    const tabs = useTabsStore.getState()
    tabs.openTab('a', { tabId: 'a' })
    tabs.openTab('b', { tabId: 'b', activate: false, title: 'B' })
    useUIStore.getState().reportUnsavedBuffer('b', 'draft-b')

    await expect(switchWorkspace('D:/other')).resolves.toBe(false)
    expect(useTabsStore.getState().tabs).toHaveLength(2)
    expect(useUIStore.getState().unsavedBuffers['b']?.content).toBe('draft-b')
    expect(api.documents.setWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('ADR-0040: a kept tab whose re-import fails is closed with its buffer', async () => {
    api.documents.get.mockImplementation(async (id: string) => doc(id, 'C:/notes/a.md', id))
    api.documents.import.mockResolvedValueOnce(null)
    useTabsStore.getState().openTab('a', { tabId: 'a' })
    useUIStore.getState().reportUnsavedBuffer('a', 'draft')

    await expect(switchWorkspace('C:/notes')).resolves.toBe(true)
    expect(useTabsStore.getState().tabs).toHaveLength(0)
    expect(useUIStore.getState().unsavedBuffers['a']).toBeUndefined()
  })

  it('ADR-0040/0042: replay target replaces its tab; a failed target import keeps the tab as anchor', async () => {
    api.documents.get.mockImplementation(async (id: string) => doc(id, 'C:/notes/a.md', id))
    api.documents.import.mockResolvedValueOnce(null)
    useTabsStore.getState().openTab('a', { tabId: 'a' })

    await expect(
      switchWorkspace('D:/other', { openPath: 'D:/other/picked.md', replayTabId: 'a' }),
    ).resolves.toBe(true)
    // The replay tab remains as the Back/Forward anchor even when the target import fails.
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual(['a'])
    // ADR-0042: the global stack records the still-open anchor document.
    expect(paths()).toEqual(['C:/notes/a.md'])
  })

  it('ADR-0040: memory-only tabs close, out-of-root backfill is skipped, and record:false suppresses history', async () => {
    api.documents.get.mockImplementation(async (id: string) =>
      id === 'draft'
        ? { id, filePath: '', title: 'draft', memoryOnly: true }
        : doc(id, 'C:/notes/a.md', id),
    )
    api.documents.import.mockImplementation(async (path: string) => ({
      id: `new-${path}`,
      filePath: path,
      title: path,
      memoryOnly: false,
    }))
    api.files.resolvePaths.mockResolvedValueOnce({
      directories: [],
      markdownFiles: ['C:/notes/a.md', 'D:/outside/extra.md'],
    })
    const tabs = useTabsStore.getState()
    tabs.openTab('draft', { tabId: 'draft', title: 'draft' })
    tabs.openTab('a', { tabId: 'a', title: 'a', activate: false })
    useUIStore.getState().reportUnsavedBuffer('a', 'draft-a')

    await expect(
      switchWorkspace('C:/notes', { openPath: 'C:/notes/target.md', record: false }),
    ).resolves.toBe(true)

    expect(api.documents.importMany).toHaveBeenCalledWith([])
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual(['a', expect.any(String)])
    expect(paths()).toEqual([])
  })

  it('ADR-0040: replay target reuses its existing tab', async () => {
    api.documents.get.mockImplementation(async (id: string) => doc(id, 'C:/notes/a.md', id))
    api.documents.import.mockImplementation(async (path: string) => ({
      id: `new-${path}`,
      filePath: path,
      title: path,
      memoryOnly: false,
    }))
    useTabsStore.getState().openTab('a', { tabId: 'a' })
    seedHistory('a', [{ path: 'C:/notes/a.md', tabId: 'a' }], 0)
    // The link-driven decision marks the source entry before the swap (workspaceExternalDecision);
    // mirror that here so the source survives pruneOutOfRoot like it does in production.
    useNavigationHistory.getState().markCurrentEntryForSwitch('C:/notes', 'a')
    useUIStore.setState({ editorSelection: { start: 4, end: 9 } })

    await expect(
      switchWorkspace('D:/other', {
        openMode: 'external-switch',
        openPath: 'D:/other/picked.md',
        replayTabId: 'a',
      }),
    ).resolves.toBe(true)
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useTabsStore.getState().tabs[0].id).toBe('a')
    expect(useTabsStore.getState().tabs[0].documentId).toBe('new-D:/other/picked.md')
    // ADR-0042 §2/§5: the switch captured the editor position into the SOURCE entry, and the
    // target entry names the tab that DISPLAYS it — the replay target, not the pre-swap snapshot.
    expect(history()[0]).toMatchObject({
      path: 'C:/notes/a.md',
      position: { start: 4, end: 9 },
    })
    expect(history()[1]).toMatchObject({
      path: 'D:/other/picked.md',
      replayRoot: 'D:/other',
      tabId: 'a',
    })
  })

  it('ADR-0040: a buffer without a title falls back to the tab title, then the imported title', async () => {
    api.documents.get.mockImplementation(async (id: string) => doc(id, 'C:/notes/a.md', id))
    api.documents.import.mockImplementation(async (path: string) => ({
      id: `new-${path}`,
      filePath: path,
      title: path,
      memoryOnly: false,
    }))
    useTabsStore.getState().openTab('a', { tabId: 'a', title: '' })
    useUIStore.getState().reportUnsavedBuffer('a', 'draft')

    await expect(switchWorkspace('C:/notes', { record: false })).resolves.toBe(true)
    expect(useUIStore.getState().unsavedBuffers['new-C:/notes/a.md']?.title).toBe('C:/notes/a.md')
  })

  it('ADR-0040: legacy no-document target import needs no tab', async () => {
    api.documents.import.mockImplementation(async (path: string) => doc('imported', path))
    await expect(switchWorkspace('D:/other', { openPath: 'D:/other/picked.md' })).resolves.toBe(
      true,
    )
    expect(useTabsStore.getState().tabs).toHaveLength(0)
    expect(paths()).toEqual(['D:/other/picked.md'])
    // ADR-0040 §3.2: no active document ⇒ no tab; the entry is recorded without a tabId.
    expect(history()[0].tabId).toBeUndefined()
  })

  it('ADR-0040: target navigation with no active tab uses the default history stack', async () => {
    api.documents.get.mockImplementation(async (id: string) => doc(id, 'D:/outside/a.md', id))
    api.documents.import.mockImplementation(async (path: string) => doc('imported-target', path))
    useTabsStore.getState().openTab('a', { tabId: 'a', activate: false })

    await expect(switchWorkspace('D:/outside', { openPath: 'D:/outside/picked.md' })).resolves.toBe(
      true,
    )
    expect(paths()).toEqual(['D:/outside/picked.md'])
    expect(useNavigationHistory.getState().entries).toHaveLength(1)
  })

  it('ADR-0040: no active tab after migration produces no history entry', async () => {
    api.documents.get.mockImplementation(async (id: string) => doc(id, 'D:/outside/a.md', id))
    useTabsStore.getState().openTab('a', { tabId: 'a' })

    await expect(switchWorkspace('C:/notes', { openMode: 'external-switch' })).resolves.toBe(true)
    expect(paths()).toEqual([])
  })
})
