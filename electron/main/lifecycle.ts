// Quit flow reuses the "close workspace" prompt
//
// Quitting the whole app must behave EXACTLY like closing a file / workspace: the
// renderer runs the same unified unsaved-changes prompt. So on `before-quit` we ask
// the renderer to close the workspace; only once it replies (app:quit-allowed) do we
// proceed. If the user cancels the prompt, the renderer simply doesn't reply and the
// quit stays aborted. New (memory-only) documents and edits to existing files are
// treated identically no special quit prompt. Memory-only drafts (empty file_path)
// are purged as a safety net so they never survive a restart, but only after the
// renderer has already run its prompt (never silently discarded).
//
// Extracted from index.ts. The quit flags live in state.ts (shared with window.ts).
import { ipcMain, app } from 'electron'
import {
  getMainWindow,
  setIsQuiting,
  getReadyToQuit,
  setReadyToQuit,
  getQuitPending,
  setQuitPending,
} from './state'
import { purgeUnsavedDrafts as storePurgeUnsavedDrafts } from './model/documentStore'
import { stopFolderWatching } from './model/folderWatcher'
import { removeOwnTempDir, scheduleRemoveAfterExit } from './lib/temp-cleanup'

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
    setQuitPending(false)
    app.quit()
  })

  ipcMain.on('app:quit-pending', () => {
    // The renderer is actively showing the unsaved-changes confirm box (dirty workspace).
    // Disarm the 5s "renderer is dead" safety net so the user has unlimited time to
    // decide; without this, the safety net would force-quit 5s after the prompt opened,
    // silently discarding the user's edits see the dirty-confirm regression
    setQuitPending(true)
  })

  app.on('before-quit', (event) => {
    if (getReadyToQuit()) {
      // Purge in-memory drafts as a safety net so they never survive a restart,
      // but only after the renderer has already run its prompt (never silently
      // discarded). The recursive watcher is torn down in 'will-quit' below so
      // its async close() resolves before the process actually exits.
      purgeUnsavedDrafts()
      return
    }
    // Fallback for quit paths that bypass the window 'close' handler (e.g. macOS
    // Cmd+Q / dock Quit, or a quit request with no live window). Ask the renderer to
    // run the unified prompt; only intercept while a window can actually show it.
    const mw = getMainWindow()
    if (mw && !mw.isDestroyed()) {
      // Per-attempt reset, same reasoning as window.ts's close handler: the
      // renderer re-reports app:quit-pending when it really shows the confirm
      // box, and until it does the 5s net must stay armed. Without this, one
      // dismissed prompt would permanently disable the net on this path too.
      setQuitPending(false)
      mw.webContents.send('app:request-quit')
      event.preventDefault()
      // Safety net: if the renderer never replies (crashed / detached), force quit
      // after a grace period so the app can never get stuck un-exitable. Disarmed
      // when the renderer reports it's showing the unsaved-changes confirm box
      // (app:quit-pending) otherwise the 5s timeout would discard the user's
      // edits while they're still deciding.
      setTimeout(() => {
        if (!getReadyToQuit() && !getQuitPending()) app.quit()
      }, 5000)
    }
  })

  app.on('will-quit', async (_event) => {
    // No preventDefault is needed: Electron waits for this handler's promise to settle.
    // Temp-dir cleanup runs FIRST and SYNCHRONOUSLY. It is the app's own contract to
    // keep %TEMP% clean (ADR-0017 / the e2e residue gate) and must NOT be gated behind
    // the async folder-watcher close below: if that `await` were ever cut short by the
    // process exiting, the cleanup would silently never run and %TEMP% would rot.
    try {
      const ownTemp = app.getPath('userData')
      removeOwnTempDir(ownTemp)
      // Always schedule the deferred removal, in EVERY mode including e2e: Chromium
      // flushes Preferences / Local State during teardown and re-creates the directory
      // right after the synchronous delete above, so only a post-exit remove is certain.
      // In e2e the *container* directory is allocated by the harness, but the runtime data
      // inside it (caches / Local Storage / preferences) is OURS — and on Windows the
      // synchronous attempt above fails with EPERM because Chromium is still holding files
      // at will-quit. The deferred deleter (electron/main/lib/temp-cleanup.ts) now RETRIES
      // until it succeeds, so a transient EPERM during Chromium's teardown flush no longer
      // leaves a directory behind. The harness's own reclaim (cleanupTempDirs) is
      // belt-and-suspenders; if it already removed the dir the deleter is a harmless no-op.
      scheduleRemoveAfterExit(ownTemp)
    } catch {
      // Best-effort: temp cleanup must not block exit.
    }
    // The recursive chokidar watcher holds native filesystem handles; leaving them
    // open can delay (or on Windows even block) exit. Release them AFTER the temp
    // cleanup above has already run, so the cleanup is never blocked on the close.
    // Electron defers exit until this async handler settles; if the process exits
    // first, the cleanup above is already done.
    try {
      await stopFolderWatching()
    } catch {
      // Best-effort: a failed watcher close must not block exit.
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
// module is not tree-shaken away by Rollup a self-invoking module with no used
// export would be dropped, silently removing the quit handlers.)
export {}
