// App-level IPC handlers: get-initial-paths / show-in-folder / get-version.
// Extracted from index.ts.
import { ipcMain, shell, app } from 'electron'
import { pendingInitialPaths } from '../state'

export function registerAppHandlers(): void {
  // After the renderer starts, proactively pull the pending open paths accumulated at launch (CLI args, etc.)
  ipcMain.handle('app:get-initial-paths', () => {
    const paths = pendingInitialPaths.splice(0, pendingInitialPaths.length)
    return paths
  })

  // Locate and highlight the given file in the system file manager
  ipcMain.handle('app:show-in-folder', (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
    } catch {
      // Ignore: the file may not exist or we lack permission
    }
  })

  // Renderer's "About" dialog fetches the app version (in production this is the injected rolling version)
  ipcMain.handle('app:get-version', () => app.getVersion())
}
