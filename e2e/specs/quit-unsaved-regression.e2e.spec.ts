import type {} from '../../src/renderer/src/vite-env.d.ts'
import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// Regression coverage for the "dirty-confirm force-quit" bug:
//
// Before the fix, the main process armed a 5s "renderer is dead" safety net whenever
// it sent `app:request-quit`. When the workspace was dirty, the renderer opened the
// unsaved-changes confirm box (an async dialog) and did NOT immediately reply with
// `app:quit-allowed`. The safety net had no way to tell "user is deciding" from
// "renderer is dead", so 5s after the prompt opened it force-quit the app — silently
// discarding the user's edits.
//
// The fix introduces `app:quit-pending`: the renderer sends it synchronously before
// opening the confirm box, and the main process disarms the safety net on receipt.
// These e2e specs verify the regression end-to-end: a dirty workspace must NOT be
// force-quit while the user is "deciding", and a clean workspace must still exit
// promptly (so the fix didn't break the normal exit path).

// Each test launches its own app instance because they assert on process
// liveness/exit, which is incompatible with a shared beforeEach app instance.
test.describe('quit flow — unsaved-changes regression', () => {
  // Stub the native `dialog:confirm` handler so it resolves immediately (false =
  // "keep editing") instead of showing an OS modal that would block the test.
  //
  // `app:quit-pending` (renderer→main) is only OBSERVED here, with an extra
  // listener that counts it. It deliberately does NOT replace the production
  // listener: `ipcMain.on` appends, so the real handlers in window.ts /
  // lifecycle.ts keep running and still disarm the safety net. Replacing them
  // (removeAllListeners) used to make this spec pass no matter what — the safety
  // net it claims to test was never armed, so deleting the fix entirely would
  // still have shown green.
  async function stubConfirmAndTrackPending(handle: AppHandle): Promise<void> {
    await handle.electronApp.evaluate((electron) => {
      const { ipcMain } = electron
      const g = globalThis as unknown as { __mf_pending?: number }
      g.__mf_pending = 0
      try {
        ipcMain.removeHandler('dialog:confirm')
      } catch {
        /* not registered yet */
      }
      ipcMain.handle('dialog:confirm', async () => false)
      ipcMain.on('app:quit-pending', () => {
        const cur = (globalThis as unknown as { __mf_pending?: number }).__mf_pending ?? 0
        ;(globalThis as unknown as { __mf_pending?: number }).__mf_pending = cur + 1
      })
    }, undefined)
  }

  async function readPendingCount(handle: AppHandle): Promise<number> {
    return handle.electronApp.evaluate(
      () => (globalThis as unknown as { __mf_pending?: number }).__mf_pending ?? 0,
      undefined,
    )
  }

  // Ask for a quit the way the user does: close the window. This goes through the
  // REAL window 'close' handler, which is the code that arms the 5s safety net.
  //
  // The previous version sent 'app:request-quit' directly to the renderer instead.
  // That skipped the close handler entirely, so no safety net was ever armed and
  // the "app survives past the 5s net" assertion could not fail — a false green.
  // (The close handler re-arms its net on every attempt, which is fine: it only
  // fires when the renderer neither replies nor reports a pending prompt.)
  async function requestCloseWindow(handle: AppHandle): Promise<void> {
    await handle.electronApp.evaluate((electron) => {
      const { BrowserWindow } = electron
      const win = BrowserWindow.getAllWindows()[0]
      win?.close()
    }, undefined)
  }

  test('dirty workspace: app stays alive past the 5s safety net while the confirm is open', async () => {
    const handle = await launchApp()
    try {
      const { page } = handle
      await waitForAppReady(page)

      await stubConfirmAndTrackPending(handle)

      // Mark the workspace dirty via the dev-only __uiStore handle. This is the
      // exact branch in tryCloseWorkspace() that opens the confirm box.
      await page.evaluate(() => {
        const w = window as unknown as {
          __uiStore?: { getState: () => { setDirty: (v: boolean) => void } }
        }
        w.__uiStore?.getState().setDirty(true)
      })

      // Trigger the quit flow through the real close handler (arms the 5s net).
      await requestCloseWindow(handle)

      // Give the renderer a moment to handle the request (send quit-pending + open confirm).
      await page.waitForTimeout(300)

      // The app:quit-pending IPC must have reached the main process (this is the
      // fix's core contract — without it, the safety net would stay armed).
      const pending = await readPendingCount(handle)
      expect(pending).toBeGreaterThanOrEqual(1)

      // Wait past the 5s safety net. If the regression is present, the app would
      // have exited by now. Give a margin (6s) so we're well past the 5s boundary.
      await page.waitForTimeout(6000)

      // The app must still be alive: the page must still evaluate.
      const alive = await page
        .evaluate(() => document.visibilityState)
        .then(() => true)
        .catch(() => false)
      expect(alive).toBe(true)

      // The dirty flag must still be set (edits not discarded).
      const stillDirty = await page.evaluate(() => {
        const w = window as unknown as { __uiStore?: { getState: () => { dirty: boolean } } }
        return w.__uiStore?.getState().dirty ?? false
      })
      expect(stillDirty).toBe(true)
    } finally {
      await closeApp(handle)
    }
  })

  test('clean workspace: app still exits promptly when there is nothing unsaved', async () => {
    // Regression guard for the fix: disarming the safety net on app:quit-pending
    // must not break the normal (clean) exit path. With no dirty state, the
    // renderer's tryCloseWorkspace() returns true and immediately calls
    // allowQuit(), so no app:quit-pending is sent and app.quit() proceeds.
    const handle = await launchApp()
    try {
      const { page } = handle
      await waitForAppReady(page)

      // Ensure dirty is false (default, but be explicit).
      await page.evaluate(() => {
        const w = window as unknown as {
          __uiStore?: { getState: () => { setDirty: (v: boolean) => void } }
        }
        w.__uiStore?.getState().setDirty(false)
      })

      await requestCloseWindow(handle)

      // Must exit well within the 5s safety net (clean path doesn't arm it).
      await expect
        .poll(
          async () => {
            // If the app has exited, this evaluate rejects (process gone).
            try {
              await handle.electronApp.evaluate(() => undefined, undefined)
              return false
            } catch {
              return true
            }
          },
          { timeout: 5000, intervals: [250] },
        )
        .toBe(true)
    } finally {
      // closeApp tolerates an already-exited app (process()?.kill is a no-op on a
      // dead process; the try/catch in closeApp swallows it).
      await closeApp(handle)
    }
  })
})
