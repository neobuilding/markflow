import { ipcRenderer } from 'electron'
import type { TabDragResult, TabHandoff, TabWindowInfo } from '../../../shared/tabTypes'
import { onIpc } from './_shared'

// ADR-0040: renderer side of the drag-session and cross-window transfer protocol.
// Every channel is `tabs:*`; main resolves the owning window from event.sender's ALS scope.

export const tabsApi = {
  beginDrag: (handoff: TabHandoff): Promise<{ token: string }> =>
    ipcRenderer.invoke('tabs:begin-drag', handoff),
  drop: (token: string, index: number): Promise<TabDragResult> =>
    ipcRenderer.invoke('tabs:drop', { token, index }),
  detach: (token: string): Promise<TabDragResult> => ipcRenderer.invoke('tabs:detach', { token }),
  cancelDrag: (token: string): Promise<void> => ipcRenderer.invoke('tabs:cancel-drag', { token }),
  takeHandoff: (): Promise<{ token: string; handoff: TabHandoff } | null> =>
    ipcRenderer.invoke('tabs:take-handoff'),
  acceptAck: (token: string): Promise<void> => ipcRenderer.invoke('tabs:accept-ack', { token }),
  moveToWindow: (token: string, targetWindowId: number, index?: number): Promise<TabDragResult> =>
    ipcRenderer.invoke('tabs:move-to-window', { token, targetWindowId, index }),
  listWindows: (): Promise<TabWindowInfo[]> => ipcRenderer.invoke('tabs:list-windows'),
}

export const onTabAccept = (
  callback: (payload: { token: string; handoff: TabHandoff }) => void,
): (() => void) => onIpc('app:tab-accept', callback)

export const onTabRemove = (callback: (payload: { tabId: string }) => void): (() => void) =>
  onIpc('app:tab-remove', callback)
