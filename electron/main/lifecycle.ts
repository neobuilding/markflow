// Window close and process exit lifecycle.
//
// There is NO application-level quit handshake. Closing a window is the only unsaved-changes
// guard: `window.ts` intercepts each window's `close` event, the renderer runs the unified
// prompt, and `app:quit-allowed` lets THAT window through. There is no menu Quit and no
// `before-quit` veto. When the OS asks the app to terminate (macOS Dock Quit), Electron closes
// each window first, so the same per-window guard still runs. System shutdown is NOT
// intercepted: the OS may terminate without any prompt, and unsaved edits to existing files
// are lost there (memory-only drafts never persist by design).
//
// Win/Linux: closing the last window calls app.quit() (window-all-closed below), and
// `before-quit` then purges memory-only drafts as a safety net. macOS: the last window's
// close keeps the process alive; `activate` in index.ts recreates a window.
//
// `app:quit-pending` is registered once in ./model/quitSignals (shared with window.ts)
// and routes by event.sender to the right WindowContext, so a prompt in one window
// cannot disarm another window's 5s safety net.
//
// Extracted from index.ts. The exit flags live in state.ts (shared with window.ts).
import { ipcMain, app } from 'electron'
import { getReadyToQuit, setReadyToQuit } from './state'
import { purgeUnsavedDrafts as storePurgeUnsavedDrafts } from './model/documentStore'
import { stopAllFolderWatching } from './model/folderWatcher'
import { allContexts, exactContextFor } from './model/windowContext'
import { runInContext, scopedOnFor } from './model/ipcScope'
import './model/quitSignals' // registers the single app:quit-pending listener
import { removeOwnTempDir, scheduleRemoveAfterExit } from './lib/temp-cleanup'

export function setupLifecycle(): void {
  function purgeUnsavedDrafts(): void {
    try {
      storePurgeUnsavedDrafts()
    } catch {
      // Best-effort cleanup; drafts live in-memory so nothing persists regardless.
    }
  }

  scopedOnFor(ipcMain, 'app:quit-allowed', (event) => {
    // The renderer answered `app:request-quit` for a WINDOW close (the only sender of that
    // channel now). Attribute by exact sender: a reply from a destroyed/unknown renderer must
    // never close whichever window happens to be focused. The scoped wrapper is only for
    // ADR-0039's ALS boundary; attribution still uses exactContextFor here.
    const ctx = exactContextFor(event?.sender)
    if (!ctx || ctx.win.isDestroyed()) return

    ctx.quitPending = false
    ctx.closeAllowed = true
    ctx.win.close()
  })

  app.on('before-quit', () => {
    // No veto and no per-window fan-out here. Unsaved changes are guarded when a WINDOW
    // closes (window.ts) — including the windows Electron closes on an app quit such as
    // macOS Dock Quit. `readyToQuit` is set by window-all-closed (Win/Linux last window)
    // and by the per-window force-close timer. Purge in-memory drafts as a safety net so
    // they never survive a restart; the recursive watcher is torn down in 'will-quit'.
    if (getReadyToQuit()) {
      // ADR-0040: every window has its own document store; purge each in its ALS scope.
      // With no registered windows (tests/headless) run once in the fallback scope so the
      // safety-net purge still happens.
      const contexts = allContexts()
      if (contexts.length === 0) purgeUnsavedDrafts()
      else for (const ctx of contexts) runInContext(ctx, purgeUnsavedDrafts)
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
    // EVERY window's watches must go, not just the active one: a second window's
    // chokidar handle would keep the process alive after the last window closed.
    // Electron defers exit until this async handler settles; if the process exits
    // first, the cleanup above is already done.
    try {
      await stopAllFolderWatching()
    } catch {
      // Best-effort: a failed watcher close must not block exit.
    }
  })

  app.on('window-all-closed', () => {
    // D14: closing the last window quits on Windows/Linux but keeps the process alive
    // on macOS (Dock icon remains; `activate` recreates the window in index.ts).
    if (process.platform === 'darwin') return
    setReadyToQuit(true)
    app.quit()
  })
}

// Register the quit-flow handlers from the entry (electron/main/index.ts) via an
// explicit setupLifecycle() call BEFORE app.whenReady, preserving the original
// top-level timing. (Invoked explicitly rather than self-executing on import so the
// module is not tree-shaken away by Rollup a self-invoking module with no used
// export would be dropped, silently removing the quit handlers.)
export {}
