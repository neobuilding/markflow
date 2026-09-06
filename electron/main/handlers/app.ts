// App-level IPC handlers: get-initial-paths / show-in-folder / get-version.
// Extracted from index.ts.
import { ipcMain, shell, app, clipboard, nativeImage } from 'electron'
import { readFileSync, copyFileSync } from 'node:fs'
import { resolveAppdocPath } from '../ipc/appdoc'
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

  // Write text to the system clipboard from the renderer.
  ipcMain.handle('clipboard:write-text', (_event, text: string) => {
    try {
      clipboard.writeText(text)
    } catch {
      // Ignore clipboard failures
    }
  })

  // Copy an image to the system clipboard (PLAN §12-2). `src` is a disk path or an
  // `appdoc://` URL; `resolveAppdocPath` reuses the protocol handler's security layer
  // (doc lookup → containment check → exists) so an appdoc reference can never escape
  // its document directory. Reads raw bytes and writes a native image; failures are
  // swallowed so a bad path can't crash the handler.
  ipcMain.handle('clipboard:write-image', (_event, src: string) => {
    try {
      const path = src.startsWith('appdoc://') ? resolveAppdocPath(src) : src
      if (!path) return
      const buf = readFileSync(path)
      const image = nativeImage.createFromBuffer(buf)
      if (image.isEmpty()) return
      clipboard.writeImage(image)
    } catch {
      // Ignore unreadable / unsupported image paths
    }
  })

  // Open a URL in the user's default browser (used by "Open Link in Browser"
  // context-menu items, PLAN §12-1). shell.openExternal is fire-and-forget and may
  // reject on an invalid URL or if the OS declines; swallow the rejection so a bad
  // link can't crash the handler.
  ipcMain.handle('app:open-external', (_event, url: string) => {
    try {
      // Swallow both a synchronous throw and an async rejection so a bad link
      // can never crash the handler.
      void shell.openExternal(url).catch(() => {
        // Ignore rejection (invalid URL / OS declined)
      })
    } catch {
      // Ignore synchronous failure (e.g. invalid argument)
    }
  })

  // Copy a file to a user-chosen destination (used by the preview's "Save image as…" /
  // "Save diagram as…" menu items, PLAN §5.2.3 / §5.2.8). `src` may be a disk path or an
  // `appdoc://` URL; the same security layer from the protocol handler bounds the resolution.
  // Fails silently so a bad source never crashes the handler.
  ipcMain.handle('app:copy-file', (_event, src: string, dest: string) => {
    try {
      const path = src.startsWith('appdoc://') ? resolveAppdocPath(src) : src
      if (!path) return
      copyFileSync(path, dest)
    } catch {
      // Ignore unreadable source / unwritable destination
    }
  })
}
