// `app:open-in-new-window` lives in its own module so handlers/app.ts does not statically import
// window.ts (which pulls in app-paths → app.getAppPath, breaking app.test.ts's electron mock).
import type { IpcMain } from 'electron'
import { dirname } from 'node:path'
import { scopedHandleFor } from '../model/ipcScope'
import { allContexts, exactContextFor } from '../model/windowContext'
import { isInFolder } from '../model/folderMatch'
import { isMarkdownFile } from '../lib/markdown-ext'
import { nodeDiskIO, type DiskIO } from '../lib/disk-io'
import { createWindow } from '../window'

/**
 * Open `filePath` in its own window.
 *
 * Reuse first (D9): a DIFFERENT window whose workspace root already CONTAINS the file is the
 * better home for it — that window is already watching the tree, so the file belongs to it. The
 * window is focused and told to reveal the file; no second window is created. Otherwise a new
 * window is created whose workspace is the file's parent directory (D8).
 *
 * The requesting window is never a reuse candidate. A context-menu action on a file inside the
 * current workspace would otherwise match the sender itself: it is already focused and the file
 * is already revealed there, so "open in new window" would silently do nothing. The sender is
 * looked up EXACTLY (no active-window fallback): an unknown sender must not be mistaken for the
 * focused window, which would wrongly exclude that window as a legitimate reuse target.
 *
 * The filesystem check goes through the DiskIO port (docs/agents/testing.md) so the handler
 * is testable without a real disk.
 */
export function registerNewWindowHandlers(ipcMain: IpcMain, io: DiskIO = nodeDiskIO): void {
  scopedHandleFor(ipcMain, 'app:open-in-new-window', (event, filePath: string) => {
    if (!filePath || !isMarkdownFile(filePath) || !io.exists(filePath)) return false
    const requester = exactContextFor(event?.sender)
    const reuse = allContexts().find(
      (ctx) => ctx !== requester && !!ctx.workspaceRoot && isInFolder(filePath, ctx.workspaceRoot),
    )
    if (reuse && !reuse.win.isDestroyed()) {
      if (reuse.win.isMinimized()) reuse.win.restore()
      reuse.win.focus()
      reuse.win.webContents.send('app:reveal-file', filePath)
      return true
    }
    createWindow({ workspaceRoot: dirname(filePath), filePath })
    return true
  })
}
