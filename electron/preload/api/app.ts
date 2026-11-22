import { ipcRenderer } from 'electron'

// App settings bridge wraps the main-process `app:*` IPC handlers
export const appApi = {
  getTheme: () => ipcRenderer.invoke('app:get-theme'),
  setTheme: (theme: 'light' | 'dark' | 'system') => ipcRenderer.invoke('app:set-theme', theme),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getInitialPaths: () => ipcRenderer.invoke('app:get-initial-paths'),
  showInFolder: (filePath: string) => ipcRenderer.invoke('app:show-in-folder', filePath),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  // Local non-Markdown file -> OS default associated application (ADR-0038 §3.1.3).
  openPath: (filePath: string) => ipcRenderer.invoke('app:open-path', filePath),
  // Open a Markdown file in a separate workspace window (reusing one that already contains it).
  openInNewWindow: (filePath: string) => ipcRenderer.invoke('app:open-in-new-window', filePath),
  // Copy a file (disk path or appdoc:// URL) to a chosen destination (preview "Save as").
  copyFile: (src: string, dest: string) => ipcRenderer.invoke('app:copy-file', src, dest),
  setLanguage: (locale: 'en' | 'zh-CN') => ipcRenderer.send('app:set-language', locale),
  // Main asks the renderer to close the workspace (running the unified unsaved-changes
  // prompt) as part of THIS window's close; renderer calls allowQuit() once it's safe
  // to let that window close.
  allowQuit: () => ipcRenderer.send('app:quit-allowed'),
  // Sent synchronously from tryCloseWorkspace() right before opening the unsaved-changes
  // confirm box. Tells the main process to disarm THIS window's 5s "renderer is dead"
  // safety net so the user has unlimited time to decide — otherwise the net would
  // force-close the window and silently discard the user's edits while the confirm box
  // is still open.
  notifyQuitPending: () => ipcRenderer.send('app:quit-pending'),
}
