// createWindow: builds the main BrowserWindow. Extracted from index.ts.
import { BrowserWindow, screen, shell, ipcMain } from 'electron'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { VITE_DEV_SERVER_URL, RENDERER_DIST } from './lib/app-paths'
import {
  setMainWindow,
  getIsQuiting,
  setIsQuiting,
  setReadyToQuit,
  getQuitPending,
  setQuitPending,
} from './state'

// ESM shim for __dirname: under "type": "module" vite-plugin-electron no longer
// injects __dirname via esmShim() (that path only runs for CJS output), so we
// derive it from import.meta.url ourselves. This keeps preload path resolution
// working in both dev and bundled ESM main process.
const __dirname = dirname(fileURLToPath(import.meta.url))

export function createWindow(): void {
  const isDev = !!VITE_DEV_SERVER_URL

  // Get screen work area (excludes taskbar)
  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workArea // { x, y, width, height }

  // Window size is not persisted: start maximized by default. Keep a sensible initial
  // size to use as the restore size when the user un-maximizes.
  const w = Math.floor(workArea.width * 0.92)
  const h = Math.floor(workArea.height * 0.92)
  const winBounds = {
    width: w,
    height: h,
    x: workArea.x + Math.floor((workArea.width - w) / 2),
    y: workArea.y + Math.floor((workArea.height - h) / 2),
  }

  const win = new BrowserWindow({
    width: winBounds.width,
    height: winBounds.height,
    x: winBounds.x,
    y: winBounds.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#f7f7f7',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // NOTE: sandbox was disabled (was true) to work around an Electron 43 / Windows 11
      // regression where a sandboxed renderer on Win11 fails to report document.hasFocus()
      // after a document switch / focus change — leaving the editor unable to receive keyboard
      // input until an Alt-Tab. With sandbox:true the window is foreground (mainWindow.isFocused()
      // is true) yet document.hasFocus() stays false, which CodeMirror's input path depends on.
      // Disabling sandbox lets the renderer correctly gain OS focus. The preload still uses
      // contextIsolation + nodeIntegration:false, so the security boundary with the main process
      // is preserved (only the Chromium renderer sandbox layer is off).
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  // Publish the window in shared state so other modules (menu, lifecycle, handlers)
  // can reach it via getMainWindow().
  setMainWindow(win)

  win.on('ready-to-show', () => {
    // Ensure the window is NOT stuck "always on top" (a previous buggy focus path could leave it
    // on top, which interferes with normal foreground focus and typing).
    try {
      win.setAlwaysOnTop(false)
    } catch {
      /* ignore */
    }
    // Always maximized: window size is not persisted, so the bounds above only
    // serve as the restore size when the user un-maximizes. There is no
    // "start un-maximized" mode — the previous `if (startMaximized)` guarded a
    // constant `true`, so its else-branch was unreachable dead code that also
    // showed up as an uncoverable branch in the coverage gate.
    win.maximize()
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL(VITE_DEV_SERVER_URL)
    // DevTools is not opened automatically; the user can toggle it via the View menu or F12
  } else {
    // Use pathToFileURL to properly encode the path as a file:// URL.
    // loadFile() doesn't handle asar-embedded paths well, but loadURL(pathToFileURL(...))
    // gives Electron's Chromium renderer the correct file:// URL to load.
    const indexPath = join(RENDERER_DIST, 'index.html')
    win.loadURL(pathToFileURL(indexPath).href)
  }

  // After upgrading Electron (30 → 43), the old userData (redirected to %TEMP%/markflow)
  // may retain a non-100% zoom level that shrinks the whole UI (including all margins).
  // Reset the zoom to the default level after each load so the leftover zoom can't affect layout.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(0)
  })

  // Intercept the *window* close (red X / traffic-light close) so it runs the SAME
  // unsaved prompt as quitting — never destroys a window with unsaved changes silently.
  // Only once the renderer replies with app:quit-allowed do we set isQuiting and let the
  // close proceed. This guarantees the prompt always happens while the window is alive,
  // eliminating the race where before-quit fires after the window is already destroyed.
  //
  // Safety net mirrors lifecycle.ts's before-quit grace period: if the renderer never
  // replies (crashed / detached / dev server gone in e2e), force the quit after 5s so
  // the app can never get stuck un-exitable — both app.quit() (before-quit) and the
  // window X (this handler) paths are now bounded. Without this, closing the window on
  // a dead renderer left the main process waiting forever and the user could not even
  // close the window by hand (every X re-armed the preventDefault).
  //
  // The safety net is DISARMED when the renderer sends app:quit-pending (it is actively
  // showing the unsaved-changes confirm box). Without that, a dirty workspace would
  // force-quit 5s after the prompt opened, silently discarding the user's edits — see
  // the dirty-confirm regression. The renderer sends app:quit-pending synchronously
  // from tryCloseWorkspace() before opening the async dialog, so there's no race
  // between the prompt opening and the safety net firing.
  let closeForceTimer: NodeJS.Timeout | null = null
  ipcMain.on('app:quit-pending', () => {
    // Renderer is showing the unsaved-changes confirm — disarmed the safety net so
    // the user has unlimited time to decide. Registered here (not in lifecycle.ts) so
    // the close handler and the pending signal share the same closeForceTimer handle.
    setQuitPending(true)
    if (closeForceTimer) {
      clearTimeout(closeForceTimer)
      closeForceTimer = null
    }
  })
  win.on('close', (event) => {
    if (getIsQuiting()) return
    // Every close attempt starts with the safety net ARMED. quitPending is a
    // PER-ATTEMPT signal — the renderer sends app:quit-pending only once it is
    // actually showing the confirm box — so a leftover `true` from a prompt the
    // user dismissed must not carry over: it would disarm the net for every later
    // attempt too. Then a renderer that died in the meantime (crashed tab, gone
    // dev server) could never be force-closed — an un-exitable app, which is the
    // exact failure the net exists to prevent.
    setQuitPending(false)
    event.preventDefault()
    win.webContents.send('app:request-quit')
    if (closeForceTimer) clearTimeout(closeForceTimer)
    closeForceTimer = setTimeout(() => {
      // Renderer never replied within the grace period AND is not showing the
      // unsaved-changes prompt (app:quit-pending would have cleared this timer).
      // Only then force the quit so the window (and, via window-all-closed, the app)
      // can actually exit. The quitPending check is belt-and-suspenders: if the
      // timer was already cleared by app:quit-pending this callback won't run, but
      // guard anyway in case of a late re-arm.
      if (getIsQuiting() || getQuitPending()) return
      setIsQuiting(true)
      setReadyToQuit(true)
      if (!win.isDestroyed()) win.close()
    }, 5000)
  })
}
