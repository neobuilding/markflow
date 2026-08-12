import { ipcRenderer } from 'electron'

// Shared helper for the renderer→main event subscriptions exposed on window.api.
// Each call registers an ipcRenderer listener and returns an unsubscribe fn so
// the renderer can tear the subscription down on unmount.
export function onIpc(channel: string, cb: (...args: any[]) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: any[]) => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
