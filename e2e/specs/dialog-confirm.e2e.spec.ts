import type {} from '../../src/renderer/src/vite-env.d.ts'
import { test, expect, type Page } from '@playwright/test'
import {
  launchApp,
  waitForAppReady,
  closeApp,
  installConfirmSpy,
  getConfirmCalls,
  type ConfirmCall,
  type AppHandle,
} from '../helpers/launch'

// Coverage for the native unsaved-changes confirm box itself (the thing behind the
// `dialog:confirm` IPC). Playwright cannot click OS dialog buttons, so we spy
// electron.dialog.showMessageBox (installConfirmSpy) to (a) assert the box is offered
// with the correct copy + buttons and (b) auto-answer it.
//
// This is the spy-upgrade of the old plain `ipcMain.handle('dialog:confirm', () => true)`
// stub: it proves not just that the app quits, but that the confirm was *correct*
// (right message, right buttons, right default/cancel). The production `dialog:confirm`
// handler is left running, so the real dirty-quit flow is fully exercised; only the OS
// button render is skipped (which Playwright cannot reach anyway).

// Each test launches its own app instance because it asserts on process liveness/exit,
// which is incompatible with a shared beforeEach app instance.
test.describe('native confirm dialog — copy & buttons', () => {
  // Ask for a quit the way the user does: close the window. This goes through the REAL
  // window 'close' handler, which is the code that arms the 5s safety net and opens the
  // unsaved confirm when the workspace is dirty.
  async function requestCloseWindow(handle: AppHandle): Promise<void> {
    await handle.electronApp.evaluate((electron) => {
      const { BrowserWindow } = electron
      const win = BrowserWindow.getAllWindows()[0]
      win?.close()
    }, undefined)
  }

  async function markDirty(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as unknown as {
        __uiStore?: { getState: () => { setDirty: (v: boolean) => void } }
      }
      w.__uiStore?.getState().setDirty(true)
    })
  }

  test('dirty close offers the correct unsaved dialog and discards on answer', async () => {
    const handle = await launchApp()
    try {
      const { page } = handle
      await waitForAppReady(page)

      // Spy the native confirm: record every invocation AND auto-answer Discard (1).
      await installConfirmSpy(handle, { defaultResponse: 1 })

      await markDirty(page)
      await requestCloseWindow(handle)

      // The Discard answer makes the app quit almost immediately, so the renderer/page can
      // be gone before a fixed wait. Instead poll the MAIN-process global for the recorded
      // confirm (the app quits only AFTER the confirm is answered, so the record is captured
      // while the main process is still alive).
      let box: ConfirmCall | undefined
      await expect
        .poll(
          async () => {
            const calls = await getConfirmCalls(handle)
            if (calls.length >= 1) {
              box = calls[0]
              return true
            }
            return false
          },
          { timeout: 5000, intervals: [50] },
        )
        .toBe(true)
      expect(box).toBeDefined()
      // Copy: the workspace-close variant of the unsaved message (English is pinned by
      // waitForAppReady so this exact string is stable regardless of the host locale).
      expect(box!.message).toBe('You have unsaved changes. Discard them and close the workspace?')
      // Buttons the OS would render: [Keep editing, Discard], default = Discard (1),
      // Esc = Keep editing (0).
      expect(box!.buttons).toEqual(['Keep editing', 'Discard'])
      expect(box!.defaultId).toBe(1)
      expect(box!.cancelId).toBe(0)
      expect(box!.type).toBe('question')
      // The spy auto-answered Discard.
      expect(box!.response).toBe(1)

      // Because the answer was Discard, the app exits gracefully (well within the 5s net).
      await expect
        .poll(
          async () => {
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
      await closeApp(handle)
    }
  })

  test('dirty close keeps editing when the confirm is answered Keep', async () => {
    const handle = await launchApp()
    try {
      const { page } = handle
      await waitForAppReady(page)

      // Spy the native confirm: record every invocation AND auto-answer Keep (0) this time.
      await installConfirmSpy(handle, { defaultResponse: 0 })

      await markDirty(page)
      await requestCloseWindow(handle)

      await page.waitForTimeout(400)

      const calls = await getConfirmCalls(handle)
      expect(calls.length).toBe(1)
      // The box is offered with the same correct buttons.
      expect(calls[0].buttons).toEqual(['Keep editing', 'Discard'])
      expect(calls[0].defaultId).toBe(1)
      expect(calls[0].cancelId).toBe(0)
      // The spy auto-answered Keep editing.
      expect(calls[0].response).toBe(0)

      // App must NOT quit: it stays alive and the dirty flag is preserved (edits kept).
      await page.waitForTimeout(1000)
      const alive = await page
        .evaluate(() => document.visibilityState)
        .then(() => true)
        .catch(() => false)
      expect(alive).toBe(true)
      const stillDirty = await page.evaluate(() => {
        const w = window as unknown as { __uiStore?: { getState: () => { dirty: boolean } } }
        return w.__uiStore?.getState().dirty ?? false
      })
      expect(stillDirty).toBe(true)
    } finally {
      await closeApp(handle)
    }
  })
})
