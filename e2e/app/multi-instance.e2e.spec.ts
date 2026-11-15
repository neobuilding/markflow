import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { existsSync } from 'node:fs'

// Regression guard: a second instance must be able to start while the first one is running.
// This is what "dev can open twice" means in practice, and it is exactly what a blanket
// `requestSingleInstanceLock()` broke: the second app silently quit and the spec that launched
// it hung until timeout. Each instance also owns a private user-data-dir (ADR 0016), which is
// what makes the two of them safe to run side by side.
test.describe('multiple instances', () => {
  let first: AppHandle | undefined
  let second: AppHandle | undefined

  test.afterEach(async () => {
    // Close both, newest first, so neither can mask the other's failure to shut down.
    if (second) await closeApp(second)
    if (first) await closeApp(first)
  })

  test('a second instance starts while the first is running, each with its own dir', async () => {
    first = await launchApp()
    await waitForAppReady(first.page)

    second = await launchApp()
    await waitForAppReady(second.page)

    // Both are really alive: each window renders the React root and answers an evaluate.
    // A second instance that hit the single-instance lock would have exited, leaving the
    // handle's page dead (and this assertion failing rather than timing out vaguely).
    const pids = await Promise.all(
      [first, second].map((handle) =>
        handle.electronApp.evaluate(() => process.pid as number, undefined),
      ),
    )
    expect(new Set(pids).size).toBe(2)

    // Each instance got its own profile directory, so neither can delete the other's data.
    expect(first.userDataDir).not.toBe(second.userDataDir)
    expect(existsSync(first.userDataDir)).toBe(true)
    expect(existsSync(second.userDataDir)).toBe(true)
  })
})
