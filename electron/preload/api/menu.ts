import { ipcRenderer } from 'electron'

// Window state sync: renderer tells main whether editing is allowed,
// so the native menu can enable/disable Save & Save As accordingly.
export const menuApi = {
  setEditable: (editable: boolean) => ipcRenderer.send('menu:set-editable', editable),
  setHasDocument: (has: boolean) => ipcRenderer.send('menu:set-has-document', has),
  setHasFolder: (has: boolean) => ipcRenderer.send('menu:set-has-folder', has),
  setHasDraft: (has: boolean) => ipcRenderer.send('menu:set-has-draft', has),
  setFileLocked: (locked: boolean) => ipcRenderer.send('menu:set-file-locked', locked),
}
