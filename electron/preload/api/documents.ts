import { ipcRenderer } from 'electron'

// Document operations bridge — wraps the main-process `documents:*` IPC handlers.
export const documentsApi = {
  list: (folderPath?: string) => ipcRenderer.invoke('documents:list', folderPath),
  get: (id: string) => ipcRenderer.invoke('documents:get', id),
  create: (params: {
    title?: string
    folderPath?: string
    content?: string
    ext?: string
    memoryOnly?: boolean
  }) => ipcRenderer.invoke('documents:create', params),
  update: (id: string, updates: { title?: string; content?: string }) =>
    ipcRenderer.invoke('documents:update', id, updates),
  delete: (id: string) => ipcRenderer.invoke('documents:delete', id),
  import: (filePath: string) => ipcRenderer.invoke('documents:import', filePath),
  importMany: (filePaths: string[]) => ipcRenderer.invoke('documents:import-many', filePaths),
  saveAs: (id: string, filePath: string, params: { title?: string; content?: string }) =>
    ipcRenderer.invoke('documents:save-as', id, filePath, params),
  reload: (id: string) => ipcRenderer.invoke('documents:reload', id),
  setEncoding: (id: string, encoding: string) =>
    ipcRenderer.invoke('documents:set-encoding', id, encoding),
  stat: (filePath: string) => ipcRenderer.invoke('documents:stat', filePath),
  eol: (filePath: string) => ipcRenderer.invoke('documents:eol', filePath),
  watch: (id: string) => ipcRenderer.invoke('documents:watch', id),
  unwatch: (id: string) => ipcRenderer.invoke('documents:unwatch', id),
}
