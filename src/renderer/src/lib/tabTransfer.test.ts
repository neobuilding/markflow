import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptTabHandoff, consumePendingTabHandoff, removeTransferredTab } from './tabTransfer'
import { useTabsStore } from '../store/tabs'
import { useUIStore } from '../store/ui'
import { getHistory } from '../store/tabHistory'
import type { TabHandoff } from '../../../../shared/tabTypes'
import { DOCS_KEY, queryClient } from '../lib/queryClient'

const handoff = (overrides: Partial<TabHandoff> = {}): TabHandoff => ({
  tabId: 'remote-tab',
  documentId: 'remote-doc',
  filePath: '/remote/a.md',
  workspaceRoot: '/remote',
  content: 'draft body',
  title: 'a*.md',
  external: false,
  isNewUnsaved: false,
  eol: '\n',
  history: [{ path: '/remote/a.md', openMode: 'in-place' }],
  cursor: 0,
  ...overrides,
})

function setupApi(opts: { importResult?: unknown; createResult?: unknown } = {}) {
  const importResult = 'importResult' in opts ? opts.importResult : { id: 'new-doc', title: 'a.md' }
  const createResult =
    'createResult' in opts ? opts.createResult : { id: 'new-draft', title: 'Untitled' }
  ;(window as unknown as { api: unknown }).api = {
    documents: {
      import: vi.fn(async () => importResult),
      importMany: vi.fn(async () => []),
      create: vi.fn(async () => createResult),
      getWorkspaceRoot: vi.fn(async () => null),
    },
    files: {
      resolvePaths: vi.fn(async () => ({
        directories: ['/dest/root'],
        markdownFiles: ['/dest/root/a.md', '/dest/root/sub/b.md'],
      })),
    },
  }
}

describe('tabTransfer (ADR-0040)', () => {
  beforeEach(() => {
    useTabsStore.getState().reset()
    useUIStore.setState({ unsavedBuffers: {}, dirty: false, workspaceRoot: null })
  })

  it('ADR-0040: accepting a handoff mirrors the destination workspace root', async () => {
    setupApi()
    ;(window.api.documents.getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '/dest/root',
    )
    await acceptTabHandoff(handoff())
    expect(useUIStore.getState().workspaceRoot).toBe('/dest/root')
  })

  it('imports the whole source workspace so the destination sidebar is not empty', async () => {
    setupApi()
    ;(window.api.documents.getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '/dest/root',
    )
    await acceptTabHandoff(handoff())
    expect(window.api.files.resolvePaths).toHaveBeenCalledWith(['/dest/root'])
    expect(window.api.documents.importMany).toHaveBeenCalledWith([
      '/dest/root/a.md',
      '/dest/root/sub/b.md',
    ])
  })

  it('skips the bulk import when the mirrored root has no Markdown files', async () => {
    setupApi()
    ;(window.api.documents.getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '/dest/root',
    )
    ;(window.api.files.resolvePaths as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: ['/dest/root'],
      markdownFiles: [],
    })
    await acceptTabHandoff(handoff())
    expect(window.api.files.resolvePaths).toHaveBeenCalledWith(['/dest/root'])
    expect(window.api.documents.importMany).not.toHaveBeenCalled()
    expect(useTabsStore.getState().tabs[0].documentId).toBe('new-doc')
  })

  it('refreshes the sidebar list after the handoff import under the mirrored root', async () => {
    setupApi()
    ;(window.api.documents.getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '/dest/root',
    )
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    try {
      await acceptTabHandoff(handoff())
      expect(invalidate).toHaveBeenCalledWith({ queryKey: DOCS_KEY })
    } finally {
      invalidate.mockRestore()
    }
  })

  it('ADR-0040: StrictMode double startup consumes the one-shot handoff only once', async () => {
    setupApi()
    const takeHandoff = vi
      .fn()
      .mockResolvedValueOnce({ token: 'tok', handoff: handoff() })
      .mockResolvedValueOnce(null)
    const acceptAck = vi.fn(async () => {})
    ;(window.api as unknown as { tabs: unknown }).tabs = { takeHandoff, acceptAck }

    // Both effect invocations run; the first one owns the pending handoff and must not be
    // cancelled. The second sees null and is a no-op.
    await Promise.all([consumePendingTabHandoff(), consumePendingTabHandoff()])

    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(acceptAck).toHaveBeenCalledTimes(1)
  })

  it('seeds a file-backed tab with same id, history and draft', async () => {
    setupApi()
    await acceptTabHandoff(handoff())
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe('remote-tab')
    expect(tabs[0].documentId).toBe('new-doc')
    expect(getHistory('remote-tab')?.getState().entries[0].path).toBe('/remote/a.md')
    expect(useUIStore.getState().unsavedBuffers['new-doc']).toEqual({
      content: 'draft body',
      title: 'a*.md',
      revision: 1,
    })
    expect(useUIStore.getState().dirty).toBe(true)
  })

  it('marks external file-backed imports', async () => {
    setupApi()
    await acceptTabHandoff(handoff({ external: true }))
    expect(window.api.documents.import).toHaveBeenCalledWith('/remote/a.md', { external: true })
  })

  it('re-creates a memory-only draft when path is empty', async () => {
    setupApi()
    await acceptTabHandoff(handoff({ filePath: '', content: 'body', title: 'Untitled' }))
    expect(window.api.documents.create).toHaveBeenCalledWith({
      title: 'Untitled',
      memoryOnly: true,
    })
    expect(useTabsStore.getState().tabs[0].documentId).toBe('new-draft')
  })

  it('memory-only handoff with an empty title falls back to Untitled', async () => {
    setupApi()
    await acceptTabHandoff(handoff({ filePath: '', title: '' }))
    expect(window.api.documents.create).toHaveBeenCalledWith({
      title: 'Untitled',
      memoryOnly: true,
    })
  })

  it('does nothing when import fails', async () => {
    setupApi({ importResult: null })
    await acceptTabHandoff(handoff())
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('leaves dirty untouched for a clean handoff', async () => {
    setupApi()
    await acceptTabHandoff(handoff({ content: null }))
    expect(useUIStore.getState().dirty).toBe(false)
  })

  it('removeTransferredTab drops the buffer and the tab', () => {
    setupApi()
    useTabsStore.getState().openTabWithId('remote-tab', 'doc-x', { title: 'x' })
    useUIStore.getState().reportUnsavedBuffer('doc-x', 'draft')
    removeTransferredTab('remote-tab')
    expect(useTabsStore.getState().tabs).toHaveLength(0)
    expect(useUIStore.getState().unsavedBuffers['doc-x']).toBeUndefined()
    // Unknown id is a no-op.
    removeTransferredTab('missing')
  })
})
