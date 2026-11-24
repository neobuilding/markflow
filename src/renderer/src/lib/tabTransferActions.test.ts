import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginTabDrag,
  detachTabToNewWindow,
  listOtherWindows,
  moveTabToWindow,
} from './tabTransferActions'
import { useTabsStore } from '../store/tabs'
import { useUIStore } from '../store/ui'

const tabsApi = {
  beginDrag: vi.fn(async (_handoff: unknown, token?: string) => ({ token: token ?? 'tok' })),
  detach: vi.fn(
    async (): Promise<'consumed' | 'expired' | 'no-session' | 'same-window'> => 'consumed',
  ),
  moveToWindow: vi.fn(
    async (): Promise<'consumed' | 'expired' | 'no-session' | 'same-window'> => 'consumed',
  ),
  listWindows: vi.fn(async () => [{ id: 2, title: 'B' }]),
}

describe('tabTransferActions (ADR-0040)', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      dialog: { confirm: vi.fn() },
      tabs: tabsApi,
      documents: {
        get: vi.fn(async (id: string) => ({
          id,
          filePath: `/${id}.md`,
          title: id,
          content: 'text',
        })),
        getWorkspaceRoot: vi.fn(async () => '/'),
      },
    }
    useTabsStore.getState().reset()
    useTabsStore.getState().openTab('doc-a', { tabId: 'a' })
    vi.clearAllMocks()
  })

  it('registers a drag session with the renderer-supplied token', async () => {
    await expect(beginTabDrag('a', 'token-a')).resolves.toBe(true)
    expect(tabsApi.beginDrag).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'a' }),
      'token-a',
    )
  })

  it('refuses to begin a session under a capability lock or without a tab/document', async () => {
    useUIStore.setState({ saving: true })
    await expect(beginTabDrag('a', 'x')).resolves.toBe(false)
    useUIStore.setState({ saving: false })
    await expect(beginTabDrag('missing', 'x')).resolves.toBe(false)
    ;(window.api.documents.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    await expect(beginTabDrag('a', 'x')).resolves.toBe(false)
  })

  it('refuses a registration that main rejected', async () => {
    tabsApi.beginDrag.mockResolvedValueOnce({ token: '' })
    await expect(beginTabDrag('a', 'x')).resolves.toBe(false)
  })

  it('detaches and moves only when main consumed the session', async () => {
    await expect(detachTabToNewWindow('a')).resolves.toBe(true)
    tabsApi.detach.mockResolvedValueOnce('expired' as const)
    await expect(detachTabToNewWindow('a')).resolves.toBe(false)
    await expect(moveTabToWindow('a', 2, 0)).resolves.toBe(true)
    tabsApi.moveToWindow.mockResolvedValueOnce('expired' as const)
    await expect(moveTabToWindow('a', 2)).resolves.toBe(false)
  })

  it('lists other windows through the scoped IPC', async () => {
    await expect(listOtherWindows()).resolves.toEqual([{ id: 2, title: 'B' }])
  })

  it('treats a missing tabs bridge as "no other window"', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    await expect(listOtherWindows()).resolves.toEqual([])
  })

  it('does not detach or move when the session cannot be registered', async () => {
    useUIStore.setState({ printing: true })
    await expect(detachTabToNewWindow('a')).resolves.toBe(false)
    await expect(moveTabToWindow('a', 2)).resolves.toBe(false)
    expect(tabsApi.detach).not.toHaveBeenCalled()
    expect(tabsApi.moveToWindow).not.toHaveBeenCalled()
  })
})
