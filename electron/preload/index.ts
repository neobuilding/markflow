// electron/preload/index.ts - Preload script (ESM)
import { contextBridge, ipcRenderer } from 'electron'

// Custom APIs exposed to renderer
const api = {
  // Document operations
  documents: {
    list: (folderPath?: string) => ipcRenderer.invoke('documents:list', folderPath),
    get: (id: string) => ipcRenderer.invoke('documents:get', id),
    create: (params: { title?: string; folderPath?: string; content?: string }) =>
      ipcRenderer.invoke('documents:create', params),
    update: (id: string, updates: { title?: string; content?: string }) =>
      ipcRenderer.invoke('documents:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('documents:delete', id),
    import: (filePath: string) => ipcRenderer.invoke('documents:import', filePath),
    importMany: (filePaths: string[]) => ipcRenderer.invoke('documents:import-many', filePaths),
    saveAs: (id: string, filePath: string, params: { title?: string; content?: string }) =>
      ipcRenderer.invoke('documents:save-as', id, filePath, params),
    reload: (id: string) => ipcRenderer.invoke('documents:reload', id),
    stat: (filePath: string) => ipcRenderer.invoke('documents:stat', filePath),
    watch: (id: string) => ipcRenderer.invoke('documents:watch', id),
    unwatch: (id: string) => ipcRenderer.invoke('documents:unwatch', id),
  },

  // Search
  search: {
    query: (q: string) => ipcRenderer.invoke('search:query', q),
  },

  // App settings
  app: {
    getTheme: () => ipcRenderer.invoke('app:get-theme'),
    setTheme: (theme: 'light' | 'dark' | 'system') => ipcRenderer.invoke('app:set-theme', theme),
    getInitialPaths: () => ipcRenderer.invoke('app:get-initial-paths'),
    showInFolder: (filePath: string) => ipcRenderer.invoke('app:show-in-folder', filePath),
  },

  // Files: resolve a list of file/folder paths into markdown files + directories
  files: {
    resolvePaths: (paths: string[]) => ipcRenderer.invoke('files:resolve-paths', paths),
  },

  // Dialog: let renderer trigger native file/folder pickers
  dialog: {
    openFiles: () => ipcRenderer.invoke('dialog:open-files'),
    openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
    openFolderPath: () => ipcRenderer.invoke('dialog:select-folder'),
    saveFile: (defaultPath?: string) => ipcRenderer.invoke('dialog:save-file', defaultPath),
  },

  // Window control
  window: {
    maximize: () => ipcRenderer.invoke('window:maximize'),
    unmaximize: () => ipcRenderer.invoke('window:unmaximize'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },

  // Window state sync: renderer tells main whether editing is allowed,
  // so the native menu can enable/disable Save & Save As accordingly.
  menu: {
    setEditable: (editable: boolean) => ipcRenderer.send('menu:set-editable', editable),
    setHasDocument: (has: boolean) => ipcRenderer.send('menu:set-has-document', has),
  },

  // Menu event listeners
  onMenuEvent: (
    event:
      | 'new-document'
      | 'save'
      | 'save-as'
      | 'reload'
      | 'toggle-sidebar'
      | 'toggle-preview'
      | 'open-folder'
      | 'open-files'
      | 'close-workspace'
      | 'file-details',
    callback: (data?: string | string[]) => void
  ) => {
    const handler = (_: Electron.IpcRendererEvent, data?: string | string[]) => callback(data)
    ipcRenderer.on(`menu:${event}`, handler)
    return () => ipcRenderer.removeListener(`menu:${event}`, handler)
  },

  // A file open in the editor was modified on disk by another program
  onFileChanged: (
    callback: (data: { id: string; filePath: string }) => void
  ) => {
    const handler = (_: Electron.IpcRendererEvent, data: { id: string; filePath: string }) => callback(data)
    ipcRenderer.on('app:file-changed', handler)
    return () => ipcRenderer.removeListener('app:file-changed', handler)
  },

  // Paths opened via CLI args / file association / drag-onto-dock
  onOpenPaths: (callback: (paths: string[]) => void) => {
    const handler = (_: Electron.IpcRendererEvent, paths: string[]) => callback(paths)
    ipcRenderer.on('app:open-paths', handler)
    return () => ipcRenderer.removeListener('app:open-paths', handler)
  },
}

contextBridge.exposeInMainWorld('api', api)
