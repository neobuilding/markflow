import { ipcRenderer } from 'electron'

// Clipboard bridge — writes text to the system clipboard via the main process.
// Using the Electron `clipboard` module is more reliable than navigator.clipboard
// in a renderer process (which can be unavailable depending on focus/permissions).
export const clipboardApi = {
  writeText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
}
