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
import { createDocumentStore } from './model/documentStore'
import { initMenuI18n } from './i18n'
import {
  getMainWindow,
  setIsQuiting,
  setReadyToQuit,
  setQuitPending,
  pendingInitialPaths,
} from './state'

// NOTE: This module must not reference __dirname. Under "type": "module" the
// main process is ESM, where __dirname is undefined; vite-plugin-electron's
// esmShim() only injects it for CJS output. Any code needing the module
// directory should derive it from import.meta.url (see window.ts).

// ─── Redirect runtime data directory to the system temp folder ──────────────
// By default Electron / Chromium write caches, Local Storage, lock files, etc. into
// AppData\Roaming\<app>, polluting the user directory. Here we redirect userData into the
// system temp directory instead, so no framework runtime data ever lands in the user's home.
// (Windows never reclaims %TEMP% by itself, so the app removes its own directory on exit —
// see lib/temp-cleanup.ts — which is what actually satisfies the "no persistence" requirement.)
//
// Each instance gets a directory of its OWN: %TEMP%/markflow-<pid>. What lands there was
// measured for a real run — ~1.8 MB / 35 files, exclusively Chromium runtime data (Code Cache,
// GPUCache, DawnGraphiteCache, DawnWebGPUCache, Shared Dictionary, Local Storage/leveldb,
// Network/Trust Tokens, DIPS) and no business data. The shareable-looking parts are not
// shareable: Local Storage/leveldb ships its own single-writer LOCK and the cache index files
// differ between instances, so two processes in one profile would corrupt each other.
// Giving every instance a private directory makes ownership structural instead of something
// we must prove at runtime, which is what lets several instances run side by side.
//
// This costs nothing in persistence: the app already removes its whole profile when it quits
// (that is the point of this design), so every launch starts from a clean slate anyway.
//
// A caller-supplied `--user-data-dir` still wins — Chromium's own switch, honored by every real
// launcher (including the e2e harness, which passes a fresh directory per spec). Recognizing it
// is honest input handling; no test-only environment variable is involved.
const hasExplicitUserDataDir = app.commandLine.hasSwitch('user-data-dir')
if (!hasExplicitUserDataDir) {
  try {
    app.setPath('userData', join(tmpdir(), `markflow-${process.pid}`))
  } catch {
    // If setting fails (rare), fall back to the default path
  }
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
// (e.g. "D:\...\app.asar"), so joining dist/electron (main) and dist/renderer works.
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
// Only one PACKAGED instance may run: reopening a .md file focuses the existing window instead
// of starting a second copy of the app (see `second-instance` below).
//
// Dev deliberately does NOT grab the lock, so a second `npm run dev` still opens as before —
// that is an intended workflow, not an oversight. It is only safe now because every instance
// owns a private user-data-dir: previously two dev instances wrote into the SAME %TEMP%/markflow
// (and a starting instance deleted its leftovers, wiping a live instance's profile).
//
// Note what the lock is NOT for: it no longer doubles as the ownership proof for cleanup.
// Ownership comes from the directory itself, so cleanup cannot touch another instance's data
// whether the lock is held or not.
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
  // No startup sweep: every instance owns a directory nobody else can be using (see above), so
  // there is nothing here to reclaim without risking another instance's data. Each instance
  // cleans up after itself on exit (see lib/temp-cleanup.ts) — that is the whole contract.
  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId(app.isPackaged ? 'com.mark-flow.app' : process.execPath)
    }

    setupCSP(VITE_DEV_SERVER_URL)

    await createDocumentStore()

    // appdoc: protocol handling (must be registered inside whenReady; ② and
    // registerSchemesAsPrivileged happen at two different times)
    registerAppDocProtocol()

    // Deny all permission requests: a Markdown reader needs no camera/microphone/geolocation
    // permissions
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
        setQuitPending(false)
        createWindow()
      }
    })
  })
}
