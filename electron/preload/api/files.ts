import { ipcRenderer, webUtils } from 'electron'

// Files: resolve a list of file/folder paths into markdown files + directories.
export const filesApi = {
  resolvePaths: (paths: string[]) => ipcRenderer.invoke('files:resolve-paths', paths),
  // Electron 32+ removed the File.path property in the renderer.
  // Use webUtils.getPathForFile (official API, stable since Electron 32) to recover
  // the real path. webUtils is imported at the top of this preload module and is
  // therefore always present in this context, so no availability guard is needed
  // (the pre-32 File.path fallback was dropped with it). A foreign or detached
  // File still makes the call throw, which we degrade to ''.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      // ignore and return empty string below
    }
    return ''
  },
}
