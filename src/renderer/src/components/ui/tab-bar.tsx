import * as React from 'react'
import { useTabsStore, type Tab as TabModel } from '../../store/tabs'
import { useUIStore, selectFileLocked } from '../../store/ui'
import { useT } from '../../i18n'
import { Tab, TAB_MIME } from './tab'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './context-menu'
import { buildTabHandoff } from '../../lib/tabHandoff'
import { showCloseTabDialog } from '../../lib/closeTabDialog'

// ADR-0040: the window's tab strip. Lives above the global toolbar inside EditorPane,
// never spans the sidebar (no TitleBar revival). Drag/drop delegates same-window vs
// cross-window detection to main by always calling tabs:drop(token, index).

type DragPayload = { token: string; tabId: string }

interface TabBarProps {
  onDetach?: (tabId: string) => void
  onMoveToWindow?: (tabId: string) => void
}

function parseDragPayload(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(TAB_MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DragPayload
    return typeof parsed.token === 'string' && typeof parsed.tabId === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function TabBar({ onDetach, onMoveToWindow }: TabBarProps): React.ReactElement {
  const { t } = useT()
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const activateTab = useTabsStore((s) => s.activateTab)
  const moveTab = useTabsStore((s) => s.moveTab)
  const [dropIndex, setDropIndex] = React.useState<number | null>(null)

  const close = React.useCallback(
    async (tab: TabModel) => {
      if (selectFileLocked(useUIStore.getState())) return
      const confirmed = await showCloseTabDialog(tab.title, t)
      if (!confirmed) return
      const store = useTabsStore.getState()
      const current = store.tabs.find((item) => item.id === tab.id)
      if (!current) return
      useUIStore.getState().closeTabDocument(current.documentId, current.isNewUnsaved)
      store.closeTab(tab.id)
    },
    [t],
  )

  const beginDrag = React.useCallback(async (tabId: string): Promise<string | null> => {
    if (selectFileLocked(useUIStore.getState())) return null
    const handoff = await buildTabHandoff(tabId)
    if (!handoff) return null
    const { token } = await window.api.tabs.beginDrag(handoff)
    return token
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const index = tabs.findIndex((tab) => tab.id === activeTabId)
    const delta = e.key === 'ArrowLeft' ? -1 : 1
    const next = (index + delta + tabs.length) % tabs.length
    const nextTab = tabs[next]
    if (nextTab) activateTab(nextTab.id)
  }

  const dragTokenRef = React.useRef<string | null>(null)

  const onTabDragStart = (e: React.DragEvent, tab: TabModel) => {
    e.stopPropagation()
    // Capture the DataTransfer synchronously: React may recycle the synthetic event
    // before the async begin-drag IPC resolves.
    const dataTransfer = e.dataTransfer
    void beginDrag(tab.id).then((token) => {
      // main returns `invalid-*` when the file cannot be verified; never feed a
      // non-session token into drop/detach (it would silently no-op).
      if (!token || token.startsWith('invalid-') || !dataTransfer) return
      dragTokenRef.current = token
      dataTransfer.setData(TAB_MIME, JSON.stringify({ token, tabId: tab.id } satisfies DragPayload))
    })
    if (dataTransfer) dataTransfer.effectAllowed = 'move'
  }

  const onTabDragEnd = () => {
    // A dragend with no drop means the tab was released outside any tab strip.
    // Give a cross-window drop a tick to consume the token first; main returns
    // 'expired' if it was already consumed, so this becomes a harmless no-op.
    const token = dragTokenRef.current
    dragTokenRef.current = null
    if (!token) return
    setTimeout(() => {
      void window.api.tabs.detach(token)
    }, 50)
  }

  const onStripDragOver = (e: React.DragEvent, index: number) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropIndex(index)
  }

  const onStripDrop = async (e: React.DragEvent, index: number) => {
    const payload = parseDragPayload(e)
    if (!payload) return
    e.preventDefault()
    e.stopPropagation()
    setDropIndex(null)
    const result = await window.api.tabs.drop(payload.token, index)
    if (result === 'consumed') {
      // Cross-window: App.tsx seeds from app:tab-accept and ACKs the token.
    } else if (result === 'same-window') {
      const from = useTabsStore.getState().tabs.findIndex((tab) => tab.id === payload.tabId)
      if (from >= 0) moveTab(payload.tabId, index)
      await window.api.tabs.cancelDrag(payload.token)
    }
  }

  return (
    <div
      data-testid="tab-bar"
      role="tablist"
      aria-label={t('tab.list')}
      className="titlebar-no-drag flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)]"
      onKeyDown={onKeyDown}
      onDragOver={(e) => onStripDragOver(e, tabs.length)}
      onDrop={(e) => void onStripDrop(e, tabs.length)}
    >
      {tabs.map((tab, index) => (
        <ContextMenu key={tab.id}>
          <ContextMenuTrigger asChild>
            <div
              className="flex items-stretch"
              onDragOver={(e) => onStripDragOver(e, index)}
              onDrop={(e) => void onStripDrop(e, index)}
            >
              {dropIndex === index ? (
                <span data-testid="tab-drop-indicator" className="w-0.5 bg-[var(--color-accent)]" />
              ) : null}
              <Tab
                label={tab.title || t('tab.untitled')}
                active={tab.id === activeTabId}
                dirty={useUIStore.getState().isTabDirty(tab.documentId)}
                closeLabel={t('tab.close')}
                draggable
                onDragStart={(e) => onTabDragStart(e, tab)}
                onDragEnd={onTabDragEnd}
                onActivate={() => activateTab(tab.id)}
                onClose={() => void close(tab)}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => void close(tab)}>{t('tab.close')}</ContextMenuItem>
            <ContextMenuItem onSelect={() => onDetach?.(tab.id)}>{t('tab.detach')}</ContextMenuItem>
            <ContextMenuItem onSelect={() => onMoveToWindow?.(tab.id)}>
              {t('tab.moveToWindow')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => activateTab(tab.id)}>
              {t('tab.closeOthers')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  )
}
