import { beforeEach, describe, expect, it, vi } from 'vitest'
import { switchWorkspace } from './workspaceSwitch'
import { useUIStore } from '../store/ui'
import { useNavigationHistory } from '../store/navigationHistory'
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
})
