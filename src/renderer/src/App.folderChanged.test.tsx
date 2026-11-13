// Integration test for App.tsx's `app:folder-changed` handler.
//
// Units under test: the useEffect in App.tsx that subscribes to
// `window.api.onFolderChanged`. It must (a) scope the resulting query
// invalidation to the active folder (events under an unrelated subtree are
// dropped) and (b) coalesce a burst of folder-changed broadcasts into a single
// invalidation. The handler composes three pieces changed during the chokidar
// lag fix: the activeFolder filter (isDirInFolder), the renderer-side 300ms
// coalesce, and the React Query invalidation none of which were exercised
// together by the per-unit tests (utils.test.tsx covers isDirInFolder alone).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { useUIStore } from './store/ui'
import { queryClient, DOCS_KEY } from './lib/queryClient'

// Each callback registered via window.api.onFolderChanged. Tests fire events
// by invoking the captured callback with a synthetic payload, exactly like a
// real `app:folder-changed` IPC delivery would.
type FolderCb = (data: { dirPath: string }) => void
let folderCbs: FolderCb[] = []

// Each callback registered via window.api.onDocumentRefresh (the narrow, id-scoped
// refresh used when a document's file is deleted/renamed outside the app).
type RefreshCb = (data: { id: string }) => void
let refreshCbs: RefreshCb[] = []

// The shared New Draft action calls these directly (it is not a hook), so the fake bridge must
// expose them or a Ctrl+N key press rejects with "not a function".
const createSpy = vi.fn(async () => ({
  id: 'draft-1',
  title: 'Untitled',
  filePath: '',
  content: '',
  wordCount: 0,
  createdAt: 0,
  updatedAt: 0,
  memoryOnly: true,
}))
const menuApi = {
  setEditable: vi.fn(),
  setHasDocument: vi.fn(),
  setHasFolder: vi.fn(),
  setHasDraft: vi.fn(),
  setFileLocked: vi.fn(),
}

// The document list App derives "an unsaved draft exists" from. Kept as a named spy so a test can
// serve a memory-only draft for exactly one read.
const listSpy = vi.fn(async (): Promise<unknown[]> => [])

// App.tsx imports the `queryClient` singleton from ./lib/queryClient and calls
// `queryClient.invalidateQueries` directly (NOT via useQueryClient). So the spy
// must be attached to that same singleton, and the provider below must wrap it
// so the hook-driven subtrees (Sidebar etc.) share the same cache.
function mountApp() {
  const noop = () => () => {}
  const api = {
    onFolderChanged: (cb: FolderCb) => {
      folderCbs.push(cb)
      return () => {
        folderCbs = folderCbs.filter((c) => c !== cb)
      }
    },
    onDocumentRefresh: (cb: RefreshCb) => {
      refreshCbs.push(cb)
      return () => {
        refreshCbs = refreshCbs.filter((c) => c !== cb)
      }
    },
    onFileChanged: noop,
    onOpenPaths: noop,
    onMenuEvent: noop,
    onAppRequestQuit: noop,
    documents: {
      list: listSpy,
      get: vi.fn().mockResolvedValue(null),
      create: createSpy,
    },
    menu: menuApi,
  }
  ;(window as unknown as { api: unknown }).api = api
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  )
}

describe('App — app:folder-changed handler (integration)', () => {
  beforeEach(() => {
    folderCbs = []
    refreshCbs = []
    useUIStore.getState().setActiveFolder(null)
    useUIStore.getState().setActiveDocumentId(null)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('scopes the invalidation to the active folder: an unrelated subtree is dropped', async () => {
    useUIStore.getState().setActiveFolder('/notes')
    mountApp()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    expect(folderCbs).toHaveLength(1)

    // Event under an unrelated folder must NOT invalidate
    folderCbs[0]({ dirPath: '/unrelated' })
    // Let any stray microtask settle so a false invalidate would surface.
    await Promise.resolve()
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('invalidates for an event under the active folder subtree', async () => {
    useUIStore.getState().setActiveFolder('/notes')
    mountApp()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    folderCbs[0]({ dirPath: '/notes/sub/a.md'.replace(/\/[^/]+$/, '') }) // '/notes/sub'
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled())
  })

  it('coalesces a burst of broadcasts into a single invalidation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useUIStore.getState().setActiveFolder('/notes')
    mountApp()
    // Let the initial mount-time refetch/invalidate settle so it does not
    // pollute the burst count below.
    await vi.runOnlyPendingTimersAsync()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    invalidateSpy.mockClear()
    expect(folderCbs).toHaveLength(1)

    // Fire three broadcasts for the same folder well inside the 300ms window.
    for (let i = 0; i < 3; i++) folderCbs[0]({ dirPath: '/notes' })
    // Not yet the coalesce window has not elapsed
    expect(invalidateSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(350)
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to refreshing when no folder is open (activeFolder is null)', async () => {
    mountApp()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    // No active folder set: early events are not filtered out.
    folderCbs[0]({ dirPath: '/anywhere' })
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled())
  })

  it('invalidates only the one document detail on app:document-refresh', async () => {
    mountApp()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    expect(refreshCbs).toHaveLength(1)

    refreshCbs[0]({ id: 'd1' })
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [...DOCS_KEY, 'detail', 'd1'] }),
    )

    // A refresh with no id must not invalidate anything further (covers the `if (!id) return` guard).
    invalidateSpy.mockClear()
    refreshCbs[0]({} as { id: string })
    await Promise.resolve()
    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})

// "At most one unsaved draft" is a cross-process rule: the renderer owns the predicate, the native
// menu owns the item. Without this mirror the File > New Draft item stayed enabled while a draft
// existed — the one entry that still invited a second draft.
describe('App — native menu draft gating', () => {
  beforeEach(() => {
    menuApi.setHasDraft.mockClear()
    listSpy.mockClear()
    // Keep a previous test's document list out of this cache: App reads it through React Query.
    queryClient.clear()
  })

  it('reports no draft so File > New Draft stays enabled', async () => {
    mountApp()
    await waitFor(() => expect(menuApi.setHasDraft).toHaveBeenCalledWith(false))
  })

  it('reports an existing memory-only draft so File > New Draft greys out', async () => {
    listSpy.mockResolvedValueOnce([{ id: 'draft-1', filePath: '' }])
    mountApp()
    await waitFor(() => expect(menuApi.setHasDraft).toHaveBeenCalledWith(true))
  })
})

describe('App — window-level shortcut guards (modal owns the keyboard)', () => {
  beforeEach(() => {
    useUIStore.getState().setNewDocOpen(false)
    useUIStore.getState().setDirty(false)
    useUIStore.setState({ sidebarOpen: false })
    createSpy.mockClear()
  })

  it('stands down while a modal surface owns the keyboard', () => {
    mountApp()
    const modal = document.createElement('div')
    modal.setAttribute('data-modal-surface', '')
    document.body.appendChild(modal)
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, cancelable: true }),
    )
    expect(createSpy).not.toHaveBeenCalled()
    modal.remove()
  })

  it('Ctrl+N creates an in-memory draft directly, with no dialog (VS Code parity)', async () => {
    mountApp()
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, cancelable: true }),
    )
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1))
    expect(createSpy).toHaveBeenCalledWith({ title: 'Untitled', memoryOnly: true })
    expect(useUIStore.getState().newDocOpen).toBe(false)
    expect(useUIStore.getState().isNewUnsaved).toBe(true)
    expect(useUIStore.getState().editable).toBe(true)
  })

  it('does not toggle the sidebar while a modal surface owns the keyboard', () => {
    mountApp()
    const before = useUIStore.getState().sidebarOpen
    const modal = document.createElement('div')
    modal.setAttribute('data-modal-surface', '')
    document.body.appendChild(modal)
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, cancelable: true }),
    )
    expect(useUIStore.getState().sidebarOpen).toBe(before)
    modal.remove()
  })

  // Ctrl/Cmd+B was reassigned from the sidebar toggle to Bold. These lock the new owner: exactly
  // ONE handler (the editor's own `markdown:insert` dispatcher), and it stands down whenever the
  // user is typing somewhere else.
  describe('Ctrl/Cmd+B (Bold)', () => {
    it('dispatches the editor insert event with bold markup', () => {
      mountApp()
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true }),
      )
      expect(onInsert).toHaveBeenCalledTimes(1)
      const detail = (onInsert.mock.calls[0][0] as CustomEvent).detail
      expect(detail).toEqual({ before: '**', after: '**' })
      document.removeEventListener('markdown:insert', onInsert)
    })

    it('no longer toggles the sidebar', () => {
      mountApp()
      const before = useUIStore.getState().sidebarOpen
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true }),
      )
      expect(useUIStore.getState().sidebarOpen).toBe(before)
    })

    it('stands down while the user is typing in a text field', () => {
      mountApp()
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true }),
      )
      expect(onInsert).not.toHaveBeenCalled()
      input.remove()
      document.removeEventListener('markdown:insert', onInsert)
    })

    it('stands down while the editor find widget holds focus', () => {
      // The find & replace widget's inputs are text fields too: a shortcut that MODIFIES the
      // document must not fire while the user is typing a search term there. (The panel exemption
      // belongs to the find / replace shortcuts only.)
      mountApp()
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)
      const panel = document.createElement('div')
      panel.className = 'cm-panel'
      const input = document.createElement('input')
      panel.appendChild(input)
      document.body.appendChild(panel)
      input.focus()
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true }),
      )
      expect(onInsert).not.toHaveBeenCalled()
      panel.remove()
      document.removeEventListener('markdown:insert', onInsert)
    })

    it('stands down while a modal surface owns the keyboard', () => {
      mountApp()
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)
      const modal = document.createElement('div')
      modal.setAttribute('data-modal-surface', '')
      document.body.appendChild(modal)
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true }),
      )
      expect(onInsert).not.toHaveBeenCalled()
      modal.remove()
      document.removeEventListener('markdown:insert', onInsert)
    })
  })

  // ADR-0032 completed the formatting cluster. Every binding dispatches the editor's
  // `markdown:insert` channel — the SAME channel the toolbar buttons use — so there is exactly one
  // implementation of each action. These lock the mapping, the guards, and the keys that moved.
  describe('Ctrl/Cmd+<key> — the formatting cluster (ADR-0032)', () => {
    // The whole cluster, as the keydown initializers the app sees them.
    const CASES: Array<[KeyboardEventInit, { before: string; after: string }]> = [
      [
        { key: 'b', ctrlKey: true },
        { before: '**', after: '**' },
      ],
      [
        { key: 'i', ctrlKey: true },
        { before: '_', after: '_' },
      ],
      [
        { key: 'k', ctrlKey: true },
        { before: '[', after: '](url)' },
      ],
      [
        { key: 'e', ctrlKey: true },
        { before: '`', after: '`' },
      ],
      [
        { key: 'l', ctrlKey: true, shiftKey: true },
        { before: '- ', after: '' },
      ],
      [
        { key: 't', ctrlKey: true, shiftKey: true },
        { before: '- [ ] ', after: '' },
      ],
      [
        { key: '1', code: 'Digit1', ctrlKey: true },
        { before: '# ', after: '' },
      ],
      [
        { key: '2', code: 'Digit2', ctrlKey: true },
        { before: '## ', after: '' },
      ],
      [
        { key: '6', code: 'Digit6', ctrlKey: true },
        { before: '###### ', after: '' },
      ],
    ]

    it('maps every binding to its markup, through the shared insert channel', () => {
      mountApp()
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)
      let calls = 0
      for (const [init, expected] of CASES) {
        window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }))
        calls += 1
        expect(onInsert, JSON.stringify(init)).toHaveBeenCalledTimes(calls)
        expect((onInsert.mock.calls[calls - 1][0] as CustomEvent).detail).toEqual(expected)
      }
      document.removeEventListener('markdown:insert', onInsert)
    })

    it('stands down for the whole cluster while the user is typing in a text field', () => {
      mountApp()
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      for (const [init] of CASES) {
        window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }))
      }
      expect(onInsert).not.toHaveBeenCalled()
      input.remove()
      document.removeEventListener('markdown:insert', onInsert)
    })

    it('stands down for the whole cluster while a modal surface owns the keyboard', () => {
      mountApp()
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)
      const modal = document.createElement('div')
      modal.setAttribute('data-modal-surface', '')
      document.body.appendChild(modal)
      for (const [init] of CASES) {
        window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }))
      }
      expect(onInsert).not.toHaveBeenCalled()
      modal.remove()
      document.removeEventListener('markdown:insert', onInsert)
    })

    it('leaves the keys of the other commands alone', () => {
      mountApp()
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)
      // ⌘N new document, ⌘\ fold the panel, ⌘⇧F search in files, ⌘⇧E files view.
      for (const init of [
        { key: 'n', ctrlKey: true },
        { key: '\\', ctrlKey: true },
        { key: 'f', ctrlKey: true, shiftKey: true },
        { key: 'e', ctrlKey: true, shiftKey: true },
      ] satisfies KeyboardEventInit[]) {
        window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }))
      }
      expect(onInsert).not.toHaveBeenCalled()
      document.removeEventListener('markdown:insert', onInsert)
    })

    it('gives ⌘K to the Link action and moved Quick Open to ⌘⇧K', () => {
      mountApp()
      useUIStore.getState().setSearchOpen(false)
      const onInsert = vi.fn()
      document.addEventListener('markdown:insert', onInsert)

      // ⌘K is now the editor's Link action — it must NOT open the palette any more.
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true }),
      )
      expect(useUIStore.getState().searchOpen).toBe(false)
      expect((onInsert.mock.calls[0][0] as CustomEvent).detail).toEqual({
        before: '[',
        after: '](url)',
      })

      // The palette's own chord opens it.
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'K',
          ctrlKey: true,
          shiftKey: true,
          cancelable: true,
        }),
      )
      expect(useUIStore.getState().searchOpen).toBe(true)
      document.removeEventListener('markdown:insert', onInsert)
    })
  })
})
