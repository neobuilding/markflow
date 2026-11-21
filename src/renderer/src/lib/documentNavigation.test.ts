import { beforeEach, describe, expect, it, vi } from 'vitest'
import { moveNavigationHistory, moveToHistoryIndex, navigateToPath } from './documentNavigation'
import { useUIStore } from '../store/ui'
import { useNavigationHistory } from '../store/navigationHistory'
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
    getWorkspaceRoot: vi.fn(async (): Promise<string | null> => 'C:/notes'),
    setWorkspaceRoot: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
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

  it('asks the file guard before doing anything and cancels on Keep editing', async () => {
    useUIStore.setState({ dirty: true, activeDocumentTitle: 'a.md', activeDocumentId: 'old' })
    api.dialog.confirm.mockResolvedValueOnce(false)
    await expect(navigateToPath('C:/notes/b.md')).resolves.toBe(false)
    expect(api.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(api.dialog.confirm.mock.calls[0][0].message).toContain('unsaved changes')
    expect(useUIStore.getState().activeDocumentId).toBe('old')
  })

  it('ignores missing files', async () => {
    api.documents.stat.mockResolvedValueOnce({ exists: false, size: 0, createdAt: 0, updatedAt: 0 })
    await expect(navigateToPath('C:/notes/gone.md')).resolves.toBe(false)
    expect(paths()).toEqual([])
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

  it('does nothing at the ends of history', async () => {
    await expect(moveNavigationHistory(-1)).resolves.toBe(false)
    useNavigationHistory.getState().push('C:/notes/a.md')
    await expect(moveNavigationHistory(1)).resolves.toBe(false)
  })

  it('refuses navigation while a file transaction is locked', async () => {
    useUIStore.setState({ printing: true })
    await expect(navigateToPath('C:/notes/a.md')).resolves.toBe(false)
    await expect(moveNavigationHistory(-1)).resolves.toBe(false)
  })

  it('uses the workspaceRoot mirror when present', async () => {
    useUIStore.setState({ workspaceRoot: 'C:/notes' })
    api.documents.getWorkspaceRoot.mockClear()
    await expect(navigateToPath('C:/notes/a.md')).resolves.toBe(true)
    expect(api.documents.getWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('cancels a history move when the user keeps editing', async () => {
    const h = useNavigationHistory.getState()
    h.push('C:/notes/a.md')
    h.push('C:/notes/b.md')
    useUIStore.setState({ dirty: true, activeDocumentTitle: 'b.md', activeDocumentId: 'old' })
    api.dialog.confirm.mockResolvedValueOnce(false)
    await expect(moveNavigationHistory(-1)).resolves.toBe(false)
    expect(useNavigationHistory.getState().cursor).toBe(1)
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
})
