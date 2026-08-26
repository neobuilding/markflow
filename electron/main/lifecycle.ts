// Quit flow reuses the "close workspace" prompt (PLAN §6.5).
//
// Quitting the whole app must behave EXACTLY like closing a file / workspace: the
// renderer runs the same unified unsaved-changes prompt. So on `before-quit` we ask
// the renderer to close the workspace; only once it replies (app:quit-allowed) do we
// proceed. If the user cancels the prompt, the renderer simply doesn't reply and the
// quit stays aborted. New (memory-only) documents and edits to existing files are
// treated identically — no special quit prompt. Memory-only drafts (empty file_path)
// are purged as a safety net so they never survive a restart, but only after the
// renderer has already run its prompt (never silently discarded).
//
// Extracted from index.ts. The quit flags live in state.ts (shared with window.ts).
import { ipcMain, app } from 'electron'
import { getMainWindow, setIsQuiting, getReadyToQuit, setReadyToQuit } from './state'
import { purgeUnsavedDrafts as storePurgeUnsavedDrafts } from './model/documentStore'

export function setupLifecycle(): void {
  function purgeUnsavedDrafts(): void {
    try {
      storePurgeUnsavedDrafts()
    } catch {
      // Best-effort cleanup; drafts live in-memory so nothing persists regardless.
    }
  }

  ipcMain.on('app:quit-allowed', () => {
    // The renderer has run the unified unsaved prompt and the user confirmed (or there
    // were no unsaved changes). Mark the app as quitting and quit for real; 'before-quit'
    // will then purge and let the teardown proceed. Using app.quit() (not mainWindow.close)
    // makes closing the window and quitting the app behave identically on every platform,
    // including macOS where close() alone would only hide the window and keep the process.
    setIsQuiting(true)
    setReadyToQuit(true)
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (getReadyToQuit()) {
      purgeUnsavedDrafts()
      return
    }
    // Fallback for quit paths that bypass the window 'close' handler (e.g. macOS
    // Cmd+Q / dock Quit, or a quit request with no live window). Ask the renderer to
    // run the unified prompt; only intercept while a window can actually show it.
    const mw = getMainWindow()
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send('app:request-quit')
      event.preventDefault()
      // Safety net: if the renderer never replies (crashed / detached), force quit
      // after a grace period so the app can never get stuck un-exitable.
      setTimeout(() => {
        if (!getReadyToQuit()) app.quit()
      }, 5000)
    }
  })

  app.on('window-all-closed', () => {
    // Quit on all platforms once the last window is closed. Combined with app.quit() in
    // app:quit-allowed, closing the window and quitting the app are identical everywhere
    // (including macOS, where the default is to keep the process alive in the dock).
    app.quit()
  })
}

// Register the quit-flow handlers from the entry (electron/main/index.ts) via an
// explicit setupLifecycle() call BEFORE app.whenReady, preserving the original
// top-level timing. (Invoked explicitly rather than self-executing on import so the
// module is not tree-shaken away by Rollup — a self-invoking module with no used
// export would be dropped, silently removing the quit handlers.)
export {}
