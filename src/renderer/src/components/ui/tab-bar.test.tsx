import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from './tooltip'
import { TabBar } from './tab-bar'
import { useTabsStore } from '../../store/tabs'
import { useUIStore } from '../../store/ui'

vi.mock('../../i18n', () => ({
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.title ? `${key}:${opts.title}` : key,
  }),
}))

const tabsApi = {
  beginDrag: vi.fn(async (_handoff: unknown, token?: string) => ({
    token: token ?? 'tok',
  })),
  drop: vi.fn(async () => 'same-window' as const),
  detach: vi.fn(async () => 'consumed' as const),
  cancelDrag: vi.fn(async () => {}),
  takeHandoff: vi.fn(async () => null),
  acceptAck: vi.fn(async () => {}),
  moveToWindow: vi.fn(async () => 'consumed' as const),
  listWindows: vi.fn(async () => [{ id: 7, title: 'Other' }]),
}

function mount() {
  return render(
    <TooltipProvider>
      <TabBar />
    </TooltipProvider>,
  )
}

describe('TabBar (ADR-0040)', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      dialog: { confirm: vi.fn(async () => true) },
      tabs: tabsApi,
      documents: {
        get: vi.fn(async (id: string) => ({
          id,
          title: id,
          filePath: `/${id}.md`,
          content: '',
        })),
        getWorkspaceRoot: vi.fn(async () => null),
      },
    }
    useTabsStore.getState().reset()
    for (const id of Object.keys(useUIStore.getState().unsavedBuffers)) {
      useUIStore.getState().clearUnsavedBuffer(id)
    }
    vi.clearAllMocks()
  })

  it('renders a role=tablist with a tab per document', () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    useTabsStore.getState().openTab('doc-b', { title: 'B.md', tabId: 'b', activate: false })
    mount()
    expect(screen.getByRole('tablist')).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs[1].getAttribute('aria-selected')).toBe('false')
    expect(tabs[1].getAttribute('tabindex')).toBe('-1')
  })

  it('activates a tab on click and moves activation with arrow keys', () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    useTabsStore.getState().openTab('doc-b', { title: 'B.md', tabId: 'b', activate: false })
    mount()
    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(useTabsStore.getState().activeTabId).toBe('b')
    fireEvent.keyDown(screen.getByTestId('tab-bar'), { key: 'ArrowLeft' })
    expect(useTabsStore.getState().activeTabId).toBe('a')
  })

  it('shows a dirty dot and closes a dirty tab after confirmation', async () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    useUIStore.getState().reportUnsavedBuffer('doc-a', 'draft', 'A.md')
    mount()
    expect(screen.getByTestId('tab-dirty-dot')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tab-close'))
    await vi.waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(0))
    expect(useUIStore.getState().unsavedBuffers['doc-a']).toBeUndefined()
  })

  it('closes a clean tab WITHOUT prompting', async () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    mount()
    fireEvent.click(screen.getByTestId('tab-close'))
    await vi.waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(0))
    expect(window.api.dialog.confirm).not.toHaveBeenCalled()
  })

  it('keeps the tab when the close confirmation is cancelled', async () => {
    ;(window.api.dialog.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    useUIStore.getState().reportUnsavedBuffer('doc-a', 'draft', 'A.md')
    mount()
    fireEvent.click(screen.getByTestId('tab-close'))
    await Promise.resolve()
    expect(useTabsStore.getState().tabs).toHaveLength(1)
  })

  it('close-others removes every other tab after one aggregate prompt for dirty ones', async () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    useTabsStore.getState().openTab('doc-b', { title: 'B.md', tabId: 'b', activate: false })
    useTabsStore.getState().openTab('doc-c', { title: 'C.md', tabId: 'c', activate: false })
    useUIStore.getState().reportUnsavedBuffer('doc-b', 'draft', 'B.md')
    mount()
    fireEvent.contextMenu(screen.getAllByRole('tab')[0])
    fireEvent.click(screen.getByTestId('tab-menu-close-others'))
    await vi.waitFor(() => expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual(['a']))
    expect(window.api.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().unsavedBuffers['doc-b']).toBeUndefined()
  })

  it('begins a drag session synchronously with the DataTransfer token', async () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    mount()
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => ''),
      types: ['application/x-markflow-tab'],
      effectAllowed: 'none',
    }
    fireEvent.dragStart(screen.getByRole('tab'), { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/x-markflow-tab',
      expect.stringContaining('"tabId":"a"'),
    )
    await vi.waitFor(() => expect(tabsApi.beginDrag).toHaveBeenCalled())
    const token = JSON.parse(
      (dataTransfer.setData as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).token
    expect(tabsApi.beginDrag).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'a' }), token)
  })

  it('renders the preview tab with italic label, localized ARIA and Pin action', () => {
    const id = useTabsStore
      .getState()
      .openTab('doc-a', { title: 'A.md', tabId: 'a', preview: true })
    mount()
    const tab = screen.getByRole('tab')
    expect(tab.getAttribute('aria-label')).toContain('tab.previewAria')
    expect(tab.querySelector('.italic')?.textContent).toContain('A.md')
    expect(tab.querySelector('[title]')?.getAttribute('title')).toContain('tab.previewTooltip')
    fireEvent.doubleClick(tab)
    expect(useTabsStore.getState().previewTabId).toBeNull()
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.queryByTestId('tab-menu-pin')).toBeNull()
    expect(id).toBe('a')
  })

  it('offers Pin only for the current preview and pins it from the menu', () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a', preview: true })
    useTabsStore.getState().openTab('doc-b', { title: 'B.md', tabId: 'b', activate: false })
    mount()
    fireEvent.contextMenu(screen.getAllByRole('tab')[0])
    expect(screen.getByTestId('tab-menu-pin')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tab-menu-pin'))
    expect(useTabsStore.getState().previewTabId).toBeNull()
    fireEvent.contextMenu(screen.getAllByRole('tab')[1])
    expect(screen.queryByTestId('tab-menu-pin')).toBeNull()
  })

  it('exposes and wires the tab action menu entries', async () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    mount()
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.getByText('tab.detach')).toBeTruthy()
    expect(screen.getByText('tab.moveToWindow')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tab-menu-detach'))
    await vi.waitFor(() => expect(tabsApi.detach).toHaveBeenCalled())
    fireEvent.contextMenu(screen.getByRole('tab'))
    fireEvent.click(screen.getByTestId('tab-menu-move'))
    await vi.waitFor(() => expect(screen.getByTestId('tab-window-7')).toBeTruthy())
    fireEvent.click(screen.getByTestId('tab-window-7'))
    await vi.waitFor(() =>
      expect(tabsApi.moveToWindow).toHaveBeenCalledWith(expect.any(String), 7, undefined),
    )
  })
})
