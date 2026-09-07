import { ipcRenderer } from 'electron'

// Window control bridge wraps the main-process `window:*` IPC handlers
// NOTE: do not add window:focus / webContents.focus() IPC handlers.
// That approach was disproven (see docs.local/troubleshooting-editor-focus.md);
// the editor-focus root cause was fixed by dialog:confirm (app-modal).
export const windowApi = {
  maximize: () => ipcRenderer.invoke('window:maximize'),
  unmaximize: () => ipcRenderer.invoke('window:unmaximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
}
