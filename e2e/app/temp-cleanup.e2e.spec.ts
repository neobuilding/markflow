import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { mkTempDir, cleanupTempDirs, untrackTempDir } from '../helpers/temp'
import { existsSync } from 'node:fs'

// Each owner cleans up its own garbage, and nothing else's:
//   - the APPLICATION removes its own user-data-dir when it quits (any mode);
//   - the TEST HARNESS removes every temp dir it allocated.
// These two tests pin both halves separately, so a regression in either one goes
// red instead of being masked by the other.
test.describe('each owner cleans up its own temp garbage', () => {
  test('app auto-removes its own user-data-dir when it quits', async () => {
    const handle: AppHandle = await launchApp()
    await waitForAppReady(handle.page)

    const { userDataDir } = handle
    // The app is running, so its own temp dir must exist.
    expect(existsSync(userDataDir)).toBe(true)

    // Hand this directory over to the app: untracking removes the harness from the
    // picture, so only the application can delete it from here on. Without this,
    // the harness clearing it in closeApp would hide an app regression.
    untrackTempDir(userDataDir)

    await closeApp(handle)

    // Graceful quit runs will-quit, which deletes the dir; Electron awaits that
    // async handler, so it is gone by the time close() resolves.
    await expect
      .poll(() => existsSync(userDataDir), {
        timeout: 5_000,
        message: 'app left its own user-data-dir behind after quit',
      })
      .toBe(false)
  })

  test('harness reclaims the temp dirs it allocated', async () => {
    // No Electron launch needed: this exercises the harness side of the ownership
    // contract directly, so the feedback stays fast and deterministic.
    const scratch = mkTempDir('markflow-cleanup-spec-')
    expect(existsSync(scratch)).toBe(true)

    cleanupTempDirs()

    expect(existsSync(scratch)).toBe(false)
  })
})
