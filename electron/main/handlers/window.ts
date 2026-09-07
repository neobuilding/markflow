// Window control IPC handlers: maximize / unmaximize / is-maximized.
// Extracted from index.ts.
//
// NOTE: do not add window:focus / webContents.focus() IPC handlers.
// That approach was disproven (see docs.local/troubleshooting-editor-focus.md);
// the editor-focus root cause was fixed by dialog:confirm (app-modal).
import { ipcMain } from 'electron'
import { getMainWindow } from '../state'

export function registerWindowHandlers(): void {
  ipcMain.handle('window:maximize', () => getMainWindow()?.maximize())
  ipcMain.handle('window:unmaximize', () => getMainWindow()?.unmaximize())
  ipcMain.handle('window:is-maximized', () => !!getMainWindow()?.isMaximized())
}
