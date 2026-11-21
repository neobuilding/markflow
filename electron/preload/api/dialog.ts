import { ipcRenderer } from 'electron'
import type { ExternalOpenChoice, WorkspaceExternalChoice } from '../../../shared/linkTypes'

// Dialog: let renderer trigger native file/folder pickers.
export const dialogApi = {
  openFiles: () => ipcRenderer.invoke('dialog:open-files'),
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  openFolderPath: () => ipcRenderer.invoke('dialog:select-folder'),
  saveFile: (defaultPath?: string) => ipcRenderer.invoke('dialog:save-file', defaultPath),
  saveHtmlFile: (defaultPath?: string) => ipcRenderer.invoke('dialog:save-html', defaultPath),
  // App-modal confirm box. Unlike window.confirm (a blocking OS-modal dialog that, on close,
  // triggers a real OS window blur and can leave document.hasFocus() stuck false in Electron),
  // dialog.showMessageBox is app-modal and Electron returns focus to the renderer afterwards,
  // so it does not break typing. Returns true when the user accepts (clicks the OK button).
  confirm: (opts: { message: string; detail?: string; okText?: string; cancelText?: string }) =>
    ipcRenderer.invoke('dialog:confirm', opts),
  // ADR-0038 §3.1.3: Open / Copy / Cancel choice before handing a link to the OS.
  confirmOpenExternal: (target: string): Promise<ExternalOpenChoice> =>
    ipcRenderer.invoke('dialog:confirm-open-external', target),
  // Four-way choice for a file resolved outside the workspace root.
  confirmWorkspaceExternal: (target: string): Promise<WorkspaceExternalChoice> =>
    ipcRenderer.invoke('dialog:confirm-workspace-external', target),
}
