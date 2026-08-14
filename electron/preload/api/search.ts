import { ipcRenderer } from 'electron'

// Search bridge — wraps the main-process `search:query` IPC handler.
export const searchApi = {
  query: (q: string) => ipcRenderer.invoke('search:query', q),
}
