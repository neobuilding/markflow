// createWindow: builds the main BrowserWindow. Extracted from index.ts.
import { BrowserWindow, screen, shell } from 'electron'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { VITE_DEV_SERVER_URL, RENDERER_DIST } from './lib/app-paths'
import { setMainWindow, setReadyToQuit } from './state'
import { registerWindow, unregisterWindow } from './model/windowContext'
import { setWorkspaceRoot } from './model/workspaceRoot'
import { stopFolderWatching } from './model/folderWatcher'
import type { TabHandoff } from '../../shared/tabTypes'

// ESM shim for __dirname: under "type": "module" vite-plugin-electron no longer
// injects __dirname via esmShim() (that path only runs for CJS output), so we
// derive it from import.meta.url ourselves. This keeps preload path resolution
// working in both dev and bundled ESM main process.
const __dirname = dirname(fileURLToPath(import.meta.url))

export interface CreateWindowOptions {
  /** Workspace root the new window should open (defaults to none). */
  workspaceRoot?: string
  /** Markdown file to open as the initial active document. */
  filePath?: string
  /** Detached tab state (with token) read by the new renderer via tabs:take-handoff. */
  tabHandoff?: { token: string; handoff: TabHandoff }
}

export function createWindow(options: CreateWindowOptions = {}): void {
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
      // after a document switch / focus change leaving the editor unable to receive keyboard
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

  // Register this window's private workspace context, then publish the window as active.
  const ctx = registerWindow(win)
  // The root goes to the NEW window, explicitly: createWindow() runs inside the IPC scope of the
  // window that asked for it, so the implicit current context would be the CALLER's window.
  if (options.workspaceRoot) setWorkspaceRoot(options.workspaceRoot, ctx)
  ctx.pendingPaths = options.filePath ? [options.filePath] : []
  ctx.pendingTabHandoff = options.tabHandoff
  setMainWindow(win)
  // App-level menu commands go through getMainWindow(). Keep it pointing at the window the user
  // is actually interacting with, so menu actions target the focused window rather than whichever
  // window happened to be created last (P3 multi-window).
  win.on('focus', () => setMainWindow(win))

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
    // "start un-maximized" mode the previous `if (startMaximized)` guarded a
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

  // After upgrading Electron (30 → 43), the old userData (now %TEMP%/markflow-<pid>)
  // may retain a non-100% zoom level that shrinks the whole UI (including all margins).
  // Reset the zoom to the default level after each load so the leftover zoom can't affect layout.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(0)
  })

  // Intercept the *window* close (red X / traffic-light close, Cmd+W, or one of the
  // windows Electron closes on macOS Dock Quit) so it runs the SAME unsaved prompt as
  // closing a file / workspace never destroys a window with unsaved changes silently.
  // This is the ONLY unsaved-changes guard in the app: there is no application-level
  // quit handshake. Only once this renderer replies with app:quit-allowed does the
  // close proceed. The prompt always happens while the window is alive.
  //
  // Safety net: if the renderer never replies (crashed / detached / dev server gone in
  // e2e), force THIS window closed after 5s so it can never get stuck un-exitable.
  // Without this, closing the window on a dead renderer left the main process waiting
  // forever and the user could not even close the window by hand (every X re-armed the
  // preventDefault). If this was the last window, window-all-closed then exits on
  // Win/Linux; on macOS the process stays alive.
  //
  // The re-entrant close() from the safety net must pass through WITHOUT re-prompting.
  // That uses THIS window's one-shot `closeAllowed` flag (the same one a confirmed
  // app:quit-allowed reply sets), never a process-global "is quitting" flag: a global
  // flag would let one window's dead-renderer timeout skip ANOTHER window's unsaved
  // guard, silently discarding that window's edits.
  //
  // The safety net is DISARMED when the renderer sends app:quit-pending (it is actively
  // showing the unsaved-changes confirm box). Without that, a dirty workspace would
  // force-close 5s after the prompt opened, silently discarding the user's edits see
  // the dirty-confirm regression. The renderer sends app:quit-pending synchronously
  // from tryCloseWorkspace() before opening the async dialog, so there's no race
  // between the prompt opening and the safety net firing.
  // `app:quit-pending` is registered ONCE in ./model/quitSignals (per sender → per-window
  // ctx) instead of once per window here; the old duplicate registration made N windows
  // disarm N safety nets.
  win.on('close', (event) => {
    // A confirmed close of THIS window (from lifecycle's app:quit-allowed routing, or
    // re-entry from this window's own force-close timer) passes through without
    // re-prompting. Consume the one-shot flag so a later close is guarded again.
    if (ctx.closeAllowed) {
      ctx.closeAllowed = false
      return
    }
    // Every close attempt starts with its safety net ARMED. This is a per-attempt signal:
    // the ctx flag feeds THIS window's net only (no global mirror, no app-level vote).
    ctx.quitPending = false
    event.preventDefault()
    win.webContents.send('app:request-quit')
    if (ctx.closeForceTimer) clearTimeout(ctx.closeForceTimer)
    ctx.closeForceTimer = setTimeout(() => {
      // Check the per-window flag so a dialog in another window cannot disarm this net.
      if (ctx.quitPending) return
      // Authorize only THIS window's re-entrant close. A process-global flag here would
      // suppress the unsaved prompt of every other window still open.
      ctx.closeAllowed = true
      setReadyToQuit(true)
      if (!win.isDestroyed()) win.close()
    }, 5000)
  })

  win.on('closed', () => {
    // The window is gone: its safety-net timer has nothing left to guard, and leaving the
    // handle behind would keep a pending timer alive for the rest of the process.
    if (ctx.closeForceTimer) {
      clearTimeout(ctx.closeForceTimer)
      ctx.closeForceTimer = null
    }
    // ctx.id IS this window's webContents id (captured at registration time): the window is
    // already DESTROYED when 'closed' fires, and touching `win.webContents` on a destroyed
    // window throws "TypeError: Object has been destroyed". That uncaught exception inside an
    // Electron event handler pops the native "A JavaScript error occurred in the main process"
    // dialog, which blocks the main thread for good — the app could not quit at all.
    unregisterWindow(ctx.id)
    // STATIC import: this runs on the window-teardown path, which is also part of the app
    // shutdown path. A dynamic import there would be bundled as its own chunk (a duplicate
    // of the watcher module, with its own per-window state) and could leave the module load
    // pending while the process is tearing down.
    void stopFolderWatching(ctx)
  })
}
