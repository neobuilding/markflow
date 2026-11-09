import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { untrackTempDir, RESIDUE_GRACE_MS } from '../helpers/temp'
import { existsSync } from 'node:fs'

// Each owner cleans up its own garbage, and nothing else's. This spec keeps the
// half that REQUIRES a real Electron quit (will-quit → app-owned removal); the
// harness-owned half is pure fs logic and lives at the unit layer in
// e2e/helpers/temp.test.ts ("temp directory ownership"). Splitting them by layer
// keeps the expensive layer thin without losing either assertion (testing.md,
// "Choosing the test layer").
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
    // async handler, so it is usually gone by the time close() resolves. The
    // deadline is DERIVED from the detached deleter's worst case (the same
    // relation the residue gate pins): a hardcoded 5s was shorter than the
    // deleter's 2s defer + 6s retry budget, which could turn a SLOW but
    // successful delete into a false red.
    await expect
      .poll(() => existsSync(userDataDir), {
        timeout: RESIDUE_GRACE_MS,
        message: 'app left its own user-data-dir behind after quit',
      })
      .toBe(false)
  })
})
