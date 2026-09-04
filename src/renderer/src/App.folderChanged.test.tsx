// Integration test for App.tsx's `app:folder-changed` handler.
//
// Units under test: the useEffect in App.tsx that subscribes to
// `window.api.onFolderChanged`. It must (a) scope the resulting query
// invalidation to the active folder (events under an unrelated subtree are
// dropped) and (b) coalesce a burst of folder-changed broadcasts into a single
// invalidation. The handler composes three pieces changed during the chokidar
// lag fix: the activeFolder filter (isDirInFolder), the renderer-side 300ms
// coalesce, and the React Query invalidation — none of which were exercised
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
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
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

    // Event under an unrelated folder — must NOT invalidate.
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
    // Not yet — the coalesce window has not elapsed.
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
