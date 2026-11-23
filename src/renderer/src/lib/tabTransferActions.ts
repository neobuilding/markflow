import { buildTabHandoff } from './tabHandoff'
import type { TabWindowInfo } from '../../../../shared/tabTypes'
import { useTabsStore } from '../store/tabs'
import { selectFileLocked, useUIStore } from '../store/ui'

// ADR-0040: shared by the tab context menu and the native File menu. One implementation keeps
// the drag-session protocol (and its synchronous DataTransfer token) identical for both paths.

function newDragToken(): string {
  return `drag-${crypto.randomUUID()}`
}

export async function beginTabDrag(tabId: string, token: string): Promise<boolean> {
  if (selectFileLocked(useUIStore.getState())) return false
  const handoff = await buildTabHandoff(tabId)
  if (!handoff) return false
  // ADR-0041: dragging/moving is an explicit commitment to keep this tab.
  useTabsStore.getState().pinTab(tabId)
  const { token: registered } = await window.api.tabs.beginDrag(handoff, token)
  return registered === token
}

export async function detachTabToNewWindow(tabId: string): Promise<boolean> {
  const token = newDragToken()
  if (!(await beginTabDrag(tabId, token))) return false
  return (await window.api.tabs.detach(token)) === 'consumed'
}

export async function listOtherWindows(): Promise<TabWindowInfo[]> {
  return window.api.tabs.listWindows()
}

export async function moveTabToWindow(
  tabId: string,
  targetWindowId: number,
  index?: number,
): Promise<boolean> {
  const token = newDragToken()
  if (!(await beginTabDrag(tabId, token))) return false
  return (await window.api.tabs.moveToWindow(token, targetWindowId, index)) === 'consumed'
}
