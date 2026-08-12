// electron/main/index.ts - MarkFlow main process (ESM)
// Entry point: keeps only module-level side effects and the app-lifecycle
// orchestration. All implementation details have been moved to focused modules
// under ./lib, ./ipc, ./handlers, ./window, ./menu and ./lifecycle.
import { app, ipcMain, session, protocol, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { VITE_DEV_SERVER_URL } from './lib/app-paths'
import { setupCSP } from './lib/csp'
import { extractArgvPaths } from './lib/md-files'
import { registerAppDocProtocol } from './ipc/appdoc'
import { createWindow } from './window'
import { setupLifecycle } from './lifecycle'
import { setupMenu, registerMenuHandlers } from './menu'
import { registerDocumentHandlers } from './ipc/documents'
import { registerSearchHandlers } from './ipc/search'
import { registerExportHandlers } from './ipc/export'
import { registerThemeHandlers } from './handlers/theme'
import { registerDialogHandlers } from './handlers/dialog'
import { registerFilesHandlers } from './handlers/files'
import { registerAppHandlers } from './handlers/app'
import { registerWindowHandlers } from './handlers/window'
import { initDatabase } from './db/database'
import { initMenuI18n } from './i18n'
import { getMainWindow, setIsQuiting, setReadyToQuit, pendingInitialPaths } from './state'

// __dirname is auto-injected by vite-plugin-electron/plugin esmShim()

// ─── Redirect runtime data directory to the system temp folder ──────────────
// By default Electron / Chromium write caches, Local Storage, lock files, etc. into
// AppData\Roaming\<app>, polluting the user directory. Here we redirect userData to
// %TEMP%/markflow so all framework runtime data lands in the temp directory and is
// cleaned up automatically with the system, satisfying the "no business-data persistence"
// privacy requirement.
try {
  app.setPath('userData', join(tmpdir(), 'markflow'))
} catch {
  // If setting fails (rare), fall back to the default path
}

// ─── appdoc: privileged protocol registration (must be at module top level, before
//     app.ready, C2/C3) ───
// ① registerSchemesAsPrivileged must be called at module top level before app.ready,
//   otherwise it throws at runtime; bypassCSP:false is written explicitly so we don't
//   weaken the CSP backstop.
// ② protocol.handle('appdoc', ...) is registered inside the app.whenReady callback
//   (see registerAppDocProtocol).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appdoc',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: false,
    },
  },
])

// In production, app.getAppPath() returns the path to the extracted asar
// (e.g. "D:\...\app.asar"), so joining dist-electron/dist/renderer works.
// In dev, we rely on Vite's VITE_DEV_SERVER_URL. (MAIN_DIST / RENDERER_DIST /
// VITE_DEV_SERVER_URL now live in ./lib/app-paths.ts.)
process.env['APP_ROOT'] = join(app.getAppPath(), '..')

// Paths passed via CLI at launch, or accumulated from open-file/second-instance before
// the app is ready. (pendingInitialPaths lives in state.ts; we fill it here because
// state.ts deliberately does not depend on `app`.)
pendingInitialPaths.push(...extractArgvPaths(process.argv))

// ─── Menu IPC + exit flow ─────────────────────────────────────────────────
// In the original index.ts these were module-top-level registrations (outside
// whenReady). They must be registered BEFORE app.ready so the quit/close handlers
// are in place the moment the window can be closed. We call setupLifecycle() here
// explicitly (not rely on a module-side-effect self-invoke) because an unused
// import of a self-executing module gets tree-shaken by Rollup, which would drop
// the before-quit / app:quit-allowed / window-all-closed handlers entirely and
// make the app impossible to quit (e2e closeApp hangs). registerMenuHandlers() in
// ./menu runs at its own module load (it is invoked from setupMenu below).
setupLifecycle()

// ─── Single instance + file/protocol open handling ───────────────
// Only one instance may run (when used as the .md handler, reopening focuses the existing window).
// Dev does NOT grab the lock (the original behavior), so a second `npm run dev` works.
const shouldStart = app.isPackaged ? app.requestSingleInstanceLock() : true

// macOS: triggered when a file is dropped on the Dock icon or opened via "Open With" in Finder
app.on('open-file', (_event, filePath: string) => {
  const mw = getMainWindow()
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('app:open-paths', [filePath])
  } else {
    pendingInitialPaths.push(filePath)
  }
})

// Windows / Linux: triggered when the associated app is double-clicked while already running
app.on('second-instance', (_event, argv: string[]) => {
  const paths = extractArgvPaths(argv)
  if (paths.length === 0) return
  const mw = getMainWindow()
  if (mw && !mw.isDestroyed()) {
    if (mw.isMinimized()) mw.restore()
    mw.focus()
    mw.webContents.send('app:open-paths', paths)
  } else {
    pendingInitialPaths.push(...paths)
  }
})

if (!shouldStart) {
  // Another instance is already running; quit this one (the existing instance handles the open request)
  app.quit()
} else {
  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId(app.isPackaged ? 'com.mark-flow.app' : process.execPath)
    }

    setupCSP(VITE_DEV_SERVER_URL)

    initDatabase()

    // appdoc: protocol handling (must be registered inside whenReady; ② and
    // registerSchemesAsPrivileged happen at two different times)
    registerAppDocProtocol()

    // Deny all permission requests: a Markdown reader needs no camera/microphone/geolocation
    // permissions (§4.1)
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    registerDocumentHandlers(ipcMain, app, getMainWindow)
    registerSearchHandlers(ipcMain)
    registerExportHandlers(ipcMain)

    registerThemeHandlers()
    registerDialogHandlers()
    registerFilesHandlers()
    registerAppHandlers()
    registerWindowHandlers()

    // initMenuI18n() MUST run before setupMenu(): menuT() depends on the i18next
    // instance being initialized, otherwise the native menu shows raw key strings.
    initMenuI18n()
    createWindow()
    // Register the menu IPC handlers explicitly (NOT via a self-invoking module, which
    // Rollup tree-shakes). This must precede setupMenu() so the menu:set-* listeners are
    // live before the renderer starts syncing editable/hasDocument/printing state.
    registerMenuHandlers()
    setupMenu()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        // Defensive reset: if a future change makes closing the window keep the
        // process alive (macOS-style), a rebuilt window must not inherit the stale
        // quitting flags or it would skip the unsaved-changes prompt on next close.
        setIsQuiting(false)
        setReadyToQuit(false)
        createWindow()
      }
    })
  })
}
