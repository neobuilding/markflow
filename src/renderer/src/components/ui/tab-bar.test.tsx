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
  beginDrag: vi.fn(async () => ({ token: 'tok' })),
  drop: vi.fn(async () => 'same-window' as const),
  detach: vi.fn(async () => 'consumed' as const),
  cancelDrag: vi.fn(async () => {}),
  takeHandoff: vi.fn(async () => null),
  acceptAck: vi.fn(async () => {}),
  moveToWindow: vi.fn(async () => 'consumed' as const),
  listWindows: vi.fn(async () => []),
}

function mount(
  props: { onDetach?: (id: string) => void; onMoveToWindow?: (id: string) => void } = {},
) {
  return render(
    <TooltipProvider>
      <TabBar {...props} />
    </TooltipProvider>,
  )
}

describe('TabBar (ADR-0040)', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      dialog: { confirm: vi.fn(async () => true) },
      tabs: tabsApi,
      documents: { get: vi.fn(), getWorkspaceRoot: vi.fn() },
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

  it('shows a dirty dot and closes a tab after confirmation', async () => {
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    useUIStore.getState().reportUnsavedBuffer('doc-a', 'draft', 'A.md')
    mount()
    expect(screen.getByTestId('tab-dirty-dot')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tab-close'))
    await vi.waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(0))
    expect(useUIStore.getState().unsavedBuffers['doc-a']).toBeUndefined()
  })

  it('keeps the tab when the close confirmation is cancelled', async () => {
    ;(window.api.dialog.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    mount()
    fireEvent.click(screen.getByTestId('tab-close'))
    await Promise.resolve()
    expect(useTabsStore.getState().tabs).toHaveLength(1)
  })

  it('begins a drag session on dragstart', async () => {
    ;(window.api.documents.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'doc-a',
      title: 'A',
      filePath: '/a.md',
      content: '# A',
    })
    ;(window.api.documents.getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    mount()
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => ''),
      types: ['application/x-markflow-tab'],
      effectAllowed: 'none',
    }
    fireEvent.dragStart(screen.getByRole('tab'), { dataTransfer })
    await vi.waitFor(() => expect(tabsApi.beginDrag).toHaveBeenCalled())
  })

  it('exposes the tab action menu entries', () => {
    const onDetach = vi.fn()
    const onMoveToWindow = vi.fn()
    useTabsStore.getState().openTab('doc-a', { title: 'A.md', tabId: 'a' })
    mount({ onDetach, onMoveToWindow })
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.getByText('tab.detach')).toBeTruthy()
    expect(screen.getByText('tab.moveToWindow')).toBeTruthy()
    expect(onDetach).toBeDefined()
    expect(onMoveToWindow).toBeDefined()
  })
})
