// Window control IPC handlers: maximize / unmaximize / is-maximized.
// Extracted from index.ts.
//
// 注意：不要新增 window:focus / webContents.focus() 的 IPC。
// 该路线已被证伪（见 docs.local/troubleshooting-editor-focus.md §6/§10.6）；
// 编辑器焦点问题的根因已由 dialog:confirm（app-modal）修复。
import { ipcMain } from 'electron'
import { getMainWindow } from '../state'

export function registerWindowHandlers(): void {
  ipcMain.handle('window:maximize', () => getMainWindow()?.maximize())
  ipcMain.handle('window:unmaximize', () => getMainWindow()?.unmaximize())
  ipcMain.handle('window:is-maximized', () => !!getMainWindow()?.isMaximized())
}
