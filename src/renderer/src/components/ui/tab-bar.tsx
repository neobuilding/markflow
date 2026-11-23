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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog'
import {
  beginTabDrag,
  detachTabToNewWindow,
  listOtherWindows,
  moveTabToWindow,
} from '../../lib/tabTransferActions'
import { showCloseAllTabsDialog, showCloseTabDialog } from '../../lib/closeTabDialog'

// ADR-0040: the window's tab strip. Lives above the global toolbar inside EditorPane,
// never spans the sidebar (no TitleBar revival). Drag/drop delegates same-window vs
// cross-window detection to main by always calling tabs:drop(token, index).

type DragPayload = { token: string; tabId: string }

interface WindowPicker {
  tabId: string
  windows: Array<{ id: number; title: string }>
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

/** Renderer-proposed token: DataTransfer must be populated synchronously in `dragstart`. */
function nextDragToken(): string {
  return `drag-${crypto.randomUUID()}`
}

export function TabBar(): React.ReactElement {
  const { t } = useT()
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const previewTabId = useTabsStore((s) => s.previewTabId)
  const activateTab = useTabsStore((s) => s.activateTab)
  const pinTab = useTabsStore((s) => s.pinTab)
  const moveTab = useTabsStore((s) => s.moveTab)
  const [dropIndex, setDropIndex] = React.useState<number | null>(null)
  const [picker, setPicker] = React.useState<WindowPicker | null>(null)

  const close = React.useCallback(
    async (tab: TabModel) => {
      if (selectFileLocked(useUIStore.getState())) return
      const store = useTabsStore.getState()
      const current = store.tabs.find((item) => item.id === tab.id)
      if (!current) return
      // A clean tab closes immediately; only a dirty one gets the discard prompt (ADR-0040 §5.3).
      if (useUIStore.getState().isTabDirty(current.documentId)) {
        if (!(await showCloseTabDialog(current.title, t))) return
      }
      const latest = useTabsStore.getState().tabs.find((item) => item.id === current.id)
      if (!latest) return
      useUIStore.getState().closeTabDocument(latest.documentId, latest.isNewUnsaved)
      useTabsStore.getState().closeTab(latest.id)
    },
    [t],
  )

  const closeOthers = React.useCallback(
    async (tab: TabModel) => {
      if (selectFileLocked(useUIStore.getState())) return
      const others = useTabsStore.getState().tabs.filter((item) => item.id !== tab.id)
      if (others.length === 0) return
      const ui = useUIStore.getState()
      const dirty = others.filter((item) => ui.isTabDirty(item.documentId))
      if (dirty.length > 0) {
        if (
          !(await showCloseAllTabsDialog(
            dirty.map((item) => item.title),
            t,
          ))
        )
          return
      }
      const latest = useTabsStore.getState()
      for (const item of others) {
        useUIStore.getState().closeTabDocument(item.documentId, item.isNewUnsaved)
      }
      latest.removeTabs(others.map((item) => item.id))
    },
    [t],
  )

  const openMovePicker = React.useCallback(async (tabId: string) => {
    const windows = await listOtherWindows()
    if (windows.length === 0) return
    setPicker({ tabId, windows })
  }, [])

  const moveToWindow = React.useCallback(async (tabId: string, targetWindowId: number) => {
    if (!(await moveTabToWindow(tabId, targetWindowId))) return
    setPicker(null)
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
    const token = nextDragToken()
    // DataTransfer is only writable inside dragstart, so publish the token synchronously
    // and register the main-process session with the SAME token asynchronously.
    dragTokenRef.current = token
    e.dataTransfer.setData(TAB_MIME, JSON.stringify({ token, tabId: tab.id } satisfies DragPayload))
    e.dataTransfer.effectAllowed = 'move'
    void beginTabDrag(tab.id, token).then((ok) => {
      if (!ok && dragTokenRef.current === token) dragTokenRef.current = null
    })
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
    <>
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
                  <span
                    data-testid="tab-drop-indicator"
                    className="w-0.5 bg-[var(--color-accent)]"
                  />
                ) : null}
                <Tab
                  label={tab.title || t('tab.untitled')}
                  active={tab.id === activeTabId}
                  preview={tab.id === previewTabId}
                  previewTooltip={t('tab.previewTooltip')}
                  previewAriaSuffix={t('tab.previewAria')}
                  dirty={useUIStore.getState().isTabDirty(tab.documentId)}
                  external={tab.external}
                  closeLabel={t('tab.close')}
                  draggable
                  onDragStart={(e) => onTabDragStart(e, tab)}
                  onDragEnd={onTabDragEnd}
                  onDoubleClick={() => pinTab(tab.id)}
                  onActivate={() => activateTab(tab.id)}
                  onClose={() => void close(tab)}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {tab.id === previewTabId ? (
                <ContextMenuItem data-testid="tab-menu-pin" onSelect={() => pinTab(tab.id)}>
                  {t('tab.pin')}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem data-testid="tab-menu-close" onSelect={() => void close(tab)}>
                {t('tab.close')}
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="tab-menu-detach"
                onSelect={() => void detachTabToNewWindow(tab.id)}
              >
                {t('tab.detach')}
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="tab-menu-move"
                onSelect={() => void openMovePicker(tab.id)}
              >
                {t('tab.moveToWindow')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                data-testid="tab-menu-close-others"
                onSelect={() => void closeOthers(tab)}
              >
                {t('tab.closeOthers')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      <Dialog open={picker !== null} onOpenChange={(open) => !open && setPicker(null)}>
        <DialogContent data-testid="tab-window-picker">
          <DialogHeader>
            <DialogTitle>{t('tab.moveToWindow')}</DialogTitle>
            <p className="text-sm text-[var(--color-text-secondary)]">{t('tab.pickWindow')}</p>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            {picker?.windows.map((window) => (
              <button
                key={window.id}
                type="button"
                data-testid={`tab-window-${window.id}`}
                className="rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-overlay)] focus-ring"
                onClick={() => void moveToWindow(picker.tabId, window.id)}
              >
                {window.title}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
