import { ipcRenderer } from 'electron'

// Export: md -> standalone html (reuse the sanitized preview HTML as the single source of truth, R7)
export const exportApi = {
  embedImages: (html: string) => ipcRenderer.invoke('export:embed-images', html),
  write: (path: string, html: string, overwrite = false) =>
    ipcRenderer.invoke('export:write', path, html, overwrite),
  print: (html: string) => ipcRenderer.invoke('export:print', html),
}
