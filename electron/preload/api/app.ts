import { ipcRenderer } from 'electron'

// App settings bridge — wraps the main-process `app:*` IPC handlers.
export const appApi = {
  getTheme: () => ipcRenderer.invoke('app:get-theme'),
  setTheme: (theme: 'light' | 'dark' | 'system') => ipcRenderer.invoke('app:set-theme', theme),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getInitialPaths: () => ipcRenderer.invoke('app:get-initial-paths'),
  showInFolder: (filePath: string) => ipcRenderer.invoke('app:show-in-folder', filePath),
  setLanguage: (locale: 'en' | 'zh-CN') => ipcRenderer.send('app:set-language', locale),
  // Main asks the renderer to close the workspace (running the unified unsaved-changes
  // prompt) before quitting; renderer calls allowQuit() once it's safe to exit.
  allowQuit: () => ipcRenderer.send('app:quit-allowed'),
}
