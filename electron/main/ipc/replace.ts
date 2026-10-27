// IPC surface for the cross-file replace pipeline. Handlers do parameter plumbing ONLY — every
// decision lives in `service/replace.ts` so it can be tested without Electron.
import type { IpcMain } from 'electron'
import { getAllDocuments, updateDocument } from '../model/documentStore'
import { getWorkspaceRoot, getWorkspaceSession } from '../model/workspaceRoot'
import { markOwnWrite } from '../model/folderWatcher'
import { nodeDiskIO, type DiskIO } from '../lib/disk-io'
import {
  applyReplace,
  cancelReplace,
  planReplace,
  undoLastReplace,
  type ReplaceDeps,
} from '../service/replace'
import type {
  ReplaceApplyOptions,
  ReplacePlanOptions,
  ReplaceProgressPayload,
  ReplaceUndoOutcome,
} from '../../../shared/searchTypes'

export const REPLACE_PROGRESS_CHANNEL = 'search:replace:progress'

export function createReplaceDeps(io: DiskIO): ReplaceDeps {
  return {
    io,
    getDocuments: getAllDocuments,
    getRoot: getWorkspaceRoot,
    getSession: getWorkspaceSession,
    markOwnWrite,
    // The watcher echo is suppressed for our own write, so the store would otherwise keep serving
    // the pre-replace bytes until something else re-read the file.
    applyToStore: (documentId, content) => {
      updateDocument(documentId, { content })
    },
  }
}

export function registerReplaceHandlers(ipcMainInstance: IpcMain, io: DiskIO = nodeDiskIO): void {
  const deps = createReplaceDeps(io)

  ipcMainInstance.handle('search:replace:plan', async (event, options: ReplacePlanOptions) =>
    planReplace(options, deps, (done, total) => {
      // Pushed (not returned) because plan is asynchronous: the renderer needs the counters
      // while the scan is still running, which a single invoke/response round-trip cannot do.
      if (!event.sender.isDestroyed()) {
        event.sender.send(REPLACE_PROGRESS_CHANNEL, {
          cancelToken: options?.cancelToken,
          done,
          total,
        } satisfies ReplaceProgressPayload)
      }
    }),
  )

  ipcMainInstance.handle('search:replace:apply', (_event, options: ReplaceApplyOptions) =>
    applyReplace(options, deps),
  )

  ipcMainInstance.handle('search:replace:cancel', (_event, options: { cancelToken?: string }) =>
    cancelReplace(options?.cancelToken ?? ''),
  )

  ipcMainInstance.handle('search:replace:undo', async (): Promise<ReplaceUndoOutcome> =>
    undoLastReplace(deps),
  )
}
