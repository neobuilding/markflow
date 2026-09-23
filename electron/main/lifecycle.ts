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

  app.on('will-quit', async (event) => {
    // The recursive chokidar watcher holds native filesystem handles; leaving them
    // open can delay (or on Windows even block) exit. `will-quit` fires after all
    // windows are closed and before the process tears down, and Electron defers the
    // exit until async handlers settle. This replaces the previous fire-and-forget
    // `void stopFolderWatching()` in before-quit, which could leave handles mid-close
    // on Windows. No preventDefault is needed: Electron waits for the promise.
    void event // keep the event param so the handler signature stays explicit
    try {
      await stopFolderWatching()
    } catch {
      // Best-effort: a failed watcher close must not block exit.
    }
    // The app's userData lives in %TEMP% and Windows never cleans %TEMP%, so the app
    // removes the runtime data IT produced there, in EVERY mode:
    //   production -> %TEMP%/markflow-<pid> (app-created redirect, private per instance)
    //   e2e        -> %TEMP%/markflow-e2e-<random> (the CONTAINER is allocated by the
    //                 test harness, but the caches / Local Storage / preferences inside
    //                 it were written by this app — cleaning those is its own job)
    // Each owner handles what it created: the harness reclaims the directory it
    // allocated (e2e/helpers/temp.ts) and asserts this app-level cleanup happened.
    //
    // Step 1 is a synchronous remove; Chromium may still be holding files in its own
    // profile at this point, which makes rmSync abort. When that happens (normal run
    // only), step 2 moves the leftover aside and a detached deleter finishes the job
    // just after we exit.
    // Best-effort, like the watcher close above: cleanup must never block exit. If the
    // user-data-dir can't be resolved we simply skip the removal rather than hang quit.
    try {
      const ownTemp = app.getPath('userData')
      removeOwnTempDir(ownTemp)
      // Always schedule the deferred removal, in EVERY mode including e2e: Chromium
      // flushes Preferences / Local State during teardown and re-creates the directory
      // right after the synchronous delete above, so only a post-exit remove is certain.
      // In e2e the *container* directory is allocated by the harness, but the runtime data
      // inside it (caches / Local Storage / preferences) is OURS — and on Windows the
      // synchronous attempt above fails with EPERM because Chromium is still holding files
      // at will-quit. The deferred deleter runs after we (and our Chromium children) have
      // fully exited, so it is the only path that reliably cleans that data. The harness's
      // own reclaim (cleanupTempDirs) is belt-and-suspenders; if it already removed the dir
      // the deleter is a harmless no-op. Excluding e2e here broke the "app auto-removes its
      // own user-data-dir" contract (it must hold in ANY mode), which
      // temp-cleanup.e2e.spec.ts pins by untracking the dir from the harness.
      scheduleRemoveAfterExit(ownTemp)
    } catch {
      // Best-effort: temp cleanup must not block exit.
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
