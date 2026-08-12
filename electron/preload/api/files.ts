import { ipcRenderer, webUtils } from 'electron'

// Files: resolve a list of file/folder paths into markdown files + directories.
export const filesApi = {
  resolvePaths: (paths: string[]) => ipcRenderer.invoke('files:resolve-paths', paths),
  // Electron 32+ removed the File.path property in the renderer.
  // Use webUtils.getPathForFile (official API, stable since Electron 32) to recover
  // the real path. The webUtils object is imported at the top of this preload module
  // and is therefore always available in this context. The pre-32 File.path fallback
  // has been dropped (no longer supported).
  getPathForFile: (file: File): string => {
    try {
      if (webUtils?.getPathForFile) {
        return webUtils.getPathForFile(file)
      }
    } catch {
      // ignore and return empty string below
    }
    return ''
  },
}
