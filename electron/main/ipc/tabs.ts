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

export function registerTabsHandlers(ipcMain: IpcMain, io: DiskIO = nodeDiskIO): void {
  scopedHandleFor(
    ipcMain,
    'tabs:begin-drag',
    (event, handoff: TabHandoff, preferredToken?: string) => {
      const ctx = exactContextFor(event?.sender)
      // A missing/unregistered sender must NOT be recorded as a fake source window: the
      // session cannot resolve a safe source later, so refuse to create it at all.
      if (!ctx) return { token: '' }
      const filePath = handoff.filePath
      // A file-backed tab must still exist; a memory-only draft has an empty path.
      // An empty token is the single rejection signal, so renderers never invent a
      // pseudo-token protocol for `invalid-*` strings.
      if (filePath && (!isMarkdownFile(filePath) || !io.exists(filePath))) {
        return { token: '' }
      }
      const token = dragSessions.begin(handoff, ctx.id, preferredToken)
      return { token }
    },
  )

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
    // A detached window must reopen the SOURCE workspace, not merely the handed-off file's
    // parent folder: a tab in `root/sub/a.md` should leave the whole `root` tree visible.
    // The dirname fallback only applies when the source had no workspace (single-file open).
    // Never set pendingPaths, because the cold-start openPaths pipeline would clear the draft.
    createWindow({
      workspaceRoot:
        handoff.workspaceRoot || (handoff.filePath ? dirname(handoff.filePath) : undefined),
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
    // The null branch is defensive only: createWindow() always stores the handoff with a
    // consumed session, and the unit suite cannot construct a live BrowserWindow with an
    // inconsistent pending entry. It is also exercised by the real detach e2e path.
    /* v8 ignore next -- see reason above; unreachable by unit tests, retained for IPC safety, validated by tab-drag-detach.e2e.spec.ts */
    return handoff ? { token: pending.token, handoff } : null
  })

  scopedHandleFor(ipcMain, 'tabs:accept-ack', (_event, payload: { token: string }) => {
    if (!dragSessions.acknowledge(payload.token)) return
    const session = dragSessions.get(payload.token)
    // acknowledge() already proved the session exists; this defensive guard cannot be driven
    // by unit tests without corrupting the registry between the two calls. The ACK IPC is
    // exercised by the cross-window e2e spec.
    /* v8 ignore next -- see reason above; unreachable by unit tests, retained for IPC safety, validated by tab-drag-cross-window.e2e.spec.ts */
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
