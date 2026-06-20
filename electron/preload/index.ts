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
    toggleStar: (id: string) => ipcRenderer.invoke('documents:toggle-star', id),
    import: (filePath: string) => ipcRenderer.invoke('documents:import', filePath),
    importMany: (filePaths: string[]) => ipcRenderer.invoke('documents:import-many', filePaths),
    starred: () => ipcRenderer.invoke('documents:starred'),
  },

  // Search
  search: {
    query: (q: string) => ipcRenderer.invoke('search:query', q),
  },

  // App settings
  app: {
    getTheme: () => ipcRenderer.invoke('app:get-theme'),
    setTheme: (theme: 'light' | 'dark' | 'system') => ipcRenderer.invoke('app:set-theme', theme),
  },

  // Dialog: let renderer trigger native file/folder pickers
  dialog: {
    openFiles: () => ipcRenderer.invoke('dialog:open-files'),
    openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  },

  // Window control: fit window to content size
  window: {
    fitToContent: (contentWidth: number, contentHeight: number) =>
      ipcRenderer.invoke('window:fit-to-content', contentWidth, contentHeight),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    unmaximize: () => ipcRenderer.invoke('window:unmaximize'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },

  // Menu event listeners
  onMenuEvent: (
    event:
      | 'new-document'
      | 'save'
      | 'toggle-sidebar'
      | 'toggle-preview'
      | 'open-folder'
      | 'open-files'
      | 'fit-to-content',
    callback: (data?: string | string[]) => void
  ) => {
    const handler = (_: Electron.IpcRendererEvent, data?: string | string[]) => callback(data)
    ipcRenderer.on(`menu:${event}`, handler)
    return () => ipcRenderer.removeListener(`menu:${event}`, handler)
  },
}

contextBridge.exposeInMainWorld('api', api)
