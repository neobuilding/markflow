import { ipcRenderer } from 'electron'

// Window control bridge — wraps the main-process `window:*` IPC handlers.
// 注意：不要新增 window:focus / webContents.focus() 的 IPC。
// 该路线已被证伪（见 docs.local/troubleshooting-editor-focus.md §6/§10.6）；
// 编辑器焦点问题的根因已由 dialog:confirm（app-modal）修复。
export const windowApi = {
  maximize: () => ipcRenderer.invoke('window:maximize'),
  unmaximize: () => ipcRenderer.invoke('window:unmaximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
}
