// ADR-0040: main side of the tab drag-session / cross-window transfer protocol.
// All channels are scoped: the target window is resolved from event.sender's ALS scope,
// never from the active-window fallback. The drag registry is keyed by opaque tokens and
// consumed exactly once; the destination must ACK before the source drops its tab.
import type { IpcMain } from 'electron'
import { dirname } from 'node:path'
import { isMarkdownFile } from '../lib/markdown-ext'
import { nodeDiskIO, type DiskIO } from '../lib/disk-io'
import { scopedHandleFor } from '../model/ipcScope'
import { allContexts, exactContextFor } from '../model/windowContext'
import { TabDragSessionRegistry } from '../model/tabDragSession'
import { createWindow } from '../window'
import type { TabHandoff, TabDragResult, TabWindowInfo } from '../../../shared/tabTypes'

// The registry is process-wide: one drag session per drag gesture, shared across windows.
export const dragSessions = new TabDragSessionRegistry()

interface DropOutcome {
  result: TabDragResult
  handoff?: TabHandoff
  source?: ReturnType<typeof exactContextFor>
  target?: ReturnType<typeof exactContextFor>
}

/**
 * Shared drop/move resolution. `targetWindowId` comes from the scoped sender (drop) or
 * from the menu's explicit target (move-to-window); same-window detection is main's job.
 */
function consumeForTarget(token: string, targetWindowId: number, viaMove: boolean): DropOutcome {
  const lookup = viaMove
    ? dragSessions.consumeMoveToWindow(token, targetWindowId)
    : dragSessions.consumeDrop(token, targetWindowId)
  if (!lookup.session) return { result: lookup.result }
  const session = lookup.session
  return {
    result: lookup.result,
    handoff: session.handoff,
    source: exactContextFor({ id: session.sourceWindowId }),
    target: exactContextFor({ id: targetWindowId }),
  }
}

function deliverHandoff(
  target: ReturnType<typeof exactContextFor>,
  handoff: TabHandoff,
  token: string,
): void {
  if (!target || target.win.isDestroyed()) return
  if (target.win.isMinimized()) target.win.restore()
  target.win.focus()
  target.win.webContents.send('app:tab-accept', { token, handoff })
}

export function registerTabsHandlers(
  ipcMain: IpcMain,
  io: DiskIO = nodeDiskIO,
  _registry: TabDragSessionRegistry = dragSessions,
): void {
  scopedHandleFor(ipcMain, 'tabs:begin-drag', (event, handoff: TabHandoff) => {
    const ctx = exactContextFor(event?.sender)
    const filePath = handoff.filePath
    // A file-backed tab must still exist; a memory-only draft has an empty path.
    if (filePath && (!isMarkdownFile(filePath) || !io.exists(filePath))) {
      return { token: `invalid-${Date.now()}` }
    }
    const token = dragSessions.begin(handoff, ctx?.id ?? -1)
    return { token }
  })

  scopedHandleFor(ipcMain, 'tabs:drop', (event, payload: { token: string; index: number }) => {
    const target = exactContextFor(event?.sender)
    if (!target) return 'no-session' as TabDragResult
    const outcome = consumeForTarget(payload.token, target.id, false)
    if (outcome.result === 'consumed' && outcome.handoff) {
      deliverHandoff(outcome.target, outcome.handoff, payload.token)
    }
    return outcome.result
  })

  scopedHandleFor(ipcMain, 'tabs:detach', (event, payload: { token: string }) => {
    const lookup = dragSessions.consumeDetach(payload.token)
    if (!lookup.session || lookup.result !== 'consumed') return lookup.result
    const handoff = lookup.session.handoff
    // A file-backed detach needs the source workspace root; never set pendingPaths,
    // because the cold-start openPaths pipeline would clear the restored draft.
    createWindow({
      workspaceRoot: handoff.filePath ? dirname(handoff.filePath) : undefined,
      tabHandoff: { token: payload.token, handoff },
    })
    return 'consumed' as TabDragResult
  })

  scopedHandleFor(ipcMain, 'tabs:cancel-drag', (_event, payload: { token: string }) => {
    dragSessions.cancel(payload.token)
  })

  scopedHandleFor(ipcMain, 'tabs:take-handoff', (event) => {
    const ctx = exactContextFor(event?.sender)
    const pending = ctx?.pendingTabHandoff
    if (!pending) return null
    const handoff = dragSessions.takeHandoff(pending.token)
    ctx.pendingTabHandoff = undefined
    // A pending handoff is always accompanied by a consumed session; the null branch
    // is a defensive contract check with no reachable test path.
    /* v8 ignore next */
    return handoff ? { token: pending.token, handoff } : null
  })

  scopedHandleFor(ipcMain, 'tabs:accept-ack', (_event, payload: { token: string }) => {
    if (!dragSessions.acknowledge(payload.token)) return
    const session = dragSessions.get(payload.token)
    // acknowledge() already proved the session exists.
    /* v8 ignore next */
    const source = session ? exactContextFor({ id: session.sourceWindowId }) : undefined
    if (source && !source.win.isDestroyed()) {
      source.win.webContents.send('app:tab-remove', { tabId: session?.handoff.tabId })
    }
  })

  scopedHandleFor(
    ipcMain,
    'tabs:move-to-window',
    (_event, payload: { token: string; targetWindowId: number; index?: number }) => {
      const outcome = consumeForTarget(payload.token, payload.targetWindowId, true)
      if (outcome.result === 'consumed' && outcome.handoff) {
        deliverHandoff(outcome.target, outcome.handoff, payload.token)
      }
      return outcome.result
    },
  )

  scopedHandleFor(ipcMain, 'tabs:list-windows', (event) => {
    const requester = exactContextFor(event?.sender)
    const windows: TabWindowInfo[] = allContexts()
      .filter((ctx) => ctx !== requester)
      .map((ctx) => ({ id: ctx.id, title: ctx.win.getTitle() }))
    return windows
  })
}
