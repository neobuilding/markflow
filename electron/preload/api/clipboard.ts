import { ipcRenderer } from 'electron'

// Clipboard bridge writes text to the system clipboard via the main process
// Using the Electron `clipboard` module is more reliable than navigator.clipboard
// in a renderer process (which can be unavailable depending on focus/permissions).
export const clipboardApi = {
  writeText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
  // Copy an image to the clipboard. `src` is either a disk path, an `appdoc://`
  // URL, or a `data:` URL (e.g. a rasterized mermaid SVG); the main process resolves
  // it to bytes and writes a native image.
  writeImage: (src: string) => ipcRenderer.invoke('clipboard:write-image', src),
  // Copy an SVG as a vector (image/svg+xml) plus a text/html wrapper. Used by the
  // preview's "Copy SVG" menu item (Plan 02 §4.4 / D4).
  writeSvg: (svg: string) => ipcRenderer.invoke('clipboard:write-svg', svg),
}
